import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type {
	CompletionEvidenceAuditEvent,
	CompletionEvidenceField,
	CompletionEvidenceRecipient
} from '$lib/ports/completion-artifact-store';
import { buildVerifiedAuditChain, type AuditChainStep } from './audit-chain-test-support';
import {
	buildCompletionManifest,
	canonicalManifestJson,
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError,
	gzipCompletionArtifact,
	MAX_MANIFEST_DOCUMENT_COUNT,
	MAX_MANIFEST_FIELD_COUNT,
	MAX_MANIFEST_RECIPIENT_COUNT,
	renderCompletionMarkdown,
	sha256TextHex,
	type BuildCompletionManifestInput,
	type CompletionManifestV1
} from './completion-manifest';

const ENVELOPE_ID: string = 'envelope-1';
const SENT_COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const ARCHIVE_SHA256: string = 'a'.repeat(64);
const FIELD_A_SHA256: string = 'e'.repeat(64);
const FIELD_B_SHA256: string = 'f'.repeat(64);

const CONTEXT = { envelopeId: ENVELOPE_ID };

function defaultSteps(): AuditChainStep[] {
	return [
		{
			id: 'audit-event-1',
			eventType: 'envelope.created',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:00.000Z',
			payload: { title: 'Agreement' }
		},
		{
			id: 'audit-event-ready',
			eventType: 'envelope.ready',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-11T00:00:00.000Z',
			payload: {
				commitSha: SENT_COMMIT_SHA,
				generation: 1,
				recipients: [
					{ id: 'recipient-b', role: 'signer', routingOrder: 1 },
					{ id: 'recipient-a', role: 'viewer', routingOrder: 1 }
				]
			}
		},
		{
			id: 'audit-event-2',
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: 'recipient-b',
			occurredAt: '2026-09-13T00:00:00.000Z',
			payload: {
				recipientId: 'recipient-b',
				role: 'signer',
				routingOrder: 1,
				sentCommitSha: SENT_COMMIT_SHA,
				fields: [
					{ id: 'field-b', fieldType: 'signature', valueSha256: FIELD_B_SHA256 },
					{ id: 'field-a', fieldType: 'date', valueSha256: FIELD_A_SHA256 }
				],
				signedAt: '2026-09-13T00:00:00.000Z'
			}
		},
		{
			id: 'audit-event-3',
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: 'recipient-b',
			occurredAt: '2026-09-14T00:00:00.000Z',
			payload: { sentCommitSha: SENT_COMMIT_SHA, completedAt: '2026-09-14T00:00:00.000Z' }
		}
	];
}

async function defaultAuditEvents(): Promise<CompletionEvidenceAuditEvent[]> {
	return buildVerifiedAuditChain(CONTEXT, defaultSteps());
}

async function auditEventsWithSent(
	payload: Record<string, unknown>
): Promise<CompletionEvidenceAuditEvent[]> {
	const steps: AuditChainStep[] = defaultSteps();
	steps.splice(2, 0, {
		id: 'audit-event-sent',
		eventType: 'envelope.sent',
		actorType: 'user',
		actorId: 'user-1',
		occurredAt: '2026-09-12T00:00:00.000Z',
		payload
	});
	return buildVerifiedAuditChain(CONTEXT, steps);
}

function defaultRecipients(signedAt: string): CompletionEvidenceRecipient[] {
	return [
		{
			id: 'recipient-b',
			role: 'signer',
			routingOrder: 1,
			status: 'completed',
			decisionEventId: 'audit-event-2',
			decisionOccurredAt: signedAt
		},
		{
			id: 'recipient-a',
			role: 'viewer',
			routingOrder: 1,
			status: 'pending',
			decisionEventId: null,
			decisionOccurredAt: null
		}
	];
}

function defaultFields(): CompletionEvidenceField[] {
	return [
		{ id: 'field-b', fieldType: 'signature', valueJson: '"Signed"', valueSha256: FIELD_B_SHA256 },
		{ id: 'field-a', fieldType: 'date', valueJson: '"2026-09-13"', valueSha256: FIELD_A_SHA256 }
	];
}

async function baseInput(
	overrides: Partial<BuildCompletionManifestInput> = {}
): Promise<BuildCompletionManifestInput> {
	return {
		envelopeId: ENVELOPE_ID,
		title: 'Agreement',
		sentCommitSha: SENT_COMMIT_SHA,
		draftArchiveSha256: ARCHIVE_SHA256,
		fieldGeneration: 2,
		documents: [
			{ path: 'documents/b.md', sha256: 'c'.repeat(64) },
			{ path: 'documents/a.md', sha256: 'd'.repeat(64) }
		],
		recipients: defaultRecipients('2026-09-13T00:00:00.000Z'),
		fields: defaultFields(),
		auditEvents: await defaultAuditEvents(),
		...overrides
	};
}

describe('buildCompletionManifest', () => {
	it('sorts documents, recipients, and fields, and excludes PII fields entirely', async () => {
		const manifest: CompletionManifestV1 = await buildCompletionManifest(await baseInput());
		expect(manifest.documents.map((document) => document.path)).toEqual([
			'documents/a.md',
			'documents/b.md'
		]);
		expect(manifest.recipients.map((recipient) => recipient.id)).toEqual([
			'recipient-a',
			'recipient-b'
		]);
		expect(manifest.fields.map((field) => field.id)).toEqual(['field-a', 'field-b']);
		expect(manifest.completedAt).toBe('2026-09-14T00:00:00.000Z');
		expect(manifest.auditProof).toMatchObject({
			anchorEventType: 'envelope.completed',
			anchorEventId: 'audit-event-3',
			headSequence: 4,
			verifiedEventCount: 4,
			hashChainVerified: true
		});
		const serialized: string = JSON.stringify(manifest);
		expect(serialized).not.toContain('email');
		expect(serialized).not.toMatch(/@/);
		for (const key of Object.keys(manifest)) {
			expect(['name', 'label', 'value', 'token', 'capability', 'key']).not.toContain(key);
		}
	});

	it('produces byte-identical canonical JSON for identical evidence', async () => {
		const first: string = canonicalManifestJson(await buildCompletionManifest(await baseInput()));
		const second: string = canonicalManifestJson(await buildCompletionManifest(await baseInput()));
		expect(first).toBe(second);
		expect(await sha256TextHex(first)).toBe(await sha256TextHex(second));
	});

	it('changes the digest when evidence differs', async () => {
		const first: string = canonicalManifestJson(await buildCompletionManifest(await baseInput()));
		const second: string = canonicalManifestJson(
			await buildCompletionManifest(await baseInput({ title: 'Different Agreement' }))
		);
		expect(first).not.toBe(second);
	});

	it('carries documentSetHash and per-document identity for a mixed bundle', async () => {
		const documentSetHash: string = 'e'.repeat(64);
		const manifest: CompletionManifestV1 = await buildCompletionManifest(
			await baseInput({
				documentSetHash,
				auditEvents: await auditEventsWithSent({ documentSetHash }),
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000022',
						kind: 'pdf',
						position: 1,
						title: 'Schedule A',
						sha256: 'd'.repeat(64),
						byteSize: 2048,
						pageCount: 3
					},
					{
						id: '01900000-0000-7000-8000-000000000021',
						kind: 'markdown',
						position: 0,
						title: 'NDA',
						path: 'documents/nda.md',
						sha256: 'c'.repeat(64)
					}
				]
			})
		);
		expect(manifest.documentSetHash).toBe('e'.repeat(64));
		expect(manifest.documents.map((document) => document.id)).toEqual([
			'01900000-0000-7000-8000-000000000021',
			'01900000-0000-7000-8000-000000000022'
		]);
		expect(manifest.documents[0]).toMatchObject({ kind: 'markdown', path: 'documents/nda.md' });
		expect(manifest.documents[1]).toMatchObject({
			kind: 'pdf',
			title: 'Schedule A',
			byteSize: 2048,
			pageCount: 3
		});
		expect(canonicalManifestJson(manifest)).toContain('"documentSetHash":"' + 'e'.repeat(64) + '"');
	});

	it('fails closed when the pinned documentSetHash does not match the verified envelope.sent payload', async () => {
		await expect(
			buildCompletionManifest(
				await baseInput({
					documentSetHash: 'e'.repeat(64),
					auditEvents: await auditEventsWithSent({ documentSetHash: 'f'.repeat(64) })
				})
			)
		).rejects.toThrow(/does not match the verified envelope\.sent payload/);
	});

	it('fails closed when envelope.sent attests a documentSetHash the pinned revision does not bind', async () => {
		await expect(
			buildCompletionManifest(
				await baseInput({
					auditEvents: await auditEventsWithSent({ documentSetHash: 'e'.repeat(64) })
				})
			)
		).rejects.toThrow(/attests a document set hash the pinned revision does not bind/);
	});

	it('rejects an invalid Git commit SHA as a genuine integrity error, not a bound', async () => {
		let caught: unknown;
		try {
			await buildCompletionManifest(await baseInput({ sentCommitSha: 'not-a-sha' }));
		} catch (error: unknown) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CompletionArtifactIntegrityError);
		expect(caught).not.toBeInstanceOf(CompletionArtifactBoundExceededError);
	});

	it('rejects an empty document set', async () => {
		await expect(buildCompletionManifest(await baseInput({ documents: [] }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects an empty recipient set', async () => {
		await expect(buildCompletionManifest(await baseInput({ recipients: [] }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a document count exceeding the resource bound as too-large, not invalid evidence', async () => {
		const documents = Array.from(
			{ length: MAX_MANIFEST_DOCUMENT_COUNT + 1 },
			(_, index): { path: string; sha256: string } => ({
				path: `documents/${index}.md`,
				sha256: 'c'.repeat(64)
			})
		);
		await expect(buildCompletionManifest(await baseInput({ documents }))).rejects.toThrow(
			CompletionArtifactBoundExceededError
		);
	});

	it('rejects a recipient count exceeding the resource bound', async () => {
		const recipients: CompletionEvidenceRecipient[] = Array.from(
			{ length: MAX_MANIFEST_RECIPIENT_COUNT + 1 },
			(_, index): CompletionEvidenceRecipient => ({
				id: `recipient-extra-${index}`,
				role: 'viewer',
				routingOrder: 1,
				status: 'pending',
				decisionEventId: null,
				decisionOccurredAt: null
			})
		);
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactBoundExceededError
		);
	});

	it('rejects a field count exceeding the resource bound', async () => {
		const fields: CompletionEvidenceField[] = Array.from(
			{ length: MAX_MANIFEST_FIELD_COUNT + 1 },
			(_, index): CompletionEvidenceField => ({
				id: `field-extra-${index}`,
				fieldType: 'text',
				valueJson: '"x"',
				valueSha256: 'b'.repeat(64)
			})
		);
		await expect(buildCompletionManifest(await baseInput({ fields }))).rejects.toThrow(
			CompletionArtifactBoundExceededError
		);
	});

	it('rejects a tampered audit event even when every other check would pass', async () => {
		const events = await defaultAuditEvents();
		events[2] = {
			...events[2],
			payloadJson: JSON.stringify({
				sentCommitSha: SENT_COMMIT_SHA,
				completedAt: '2099-01-01T00:00:00.000Z'
			})
		};
		await expect(buildCompletionManifest(await baseInput({ auditEvents: events }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a tampered mid-chain draft.revision_created event', async () => {
		const steps: AuditChainStep[] = [
			defaultSteps()[0],
			{
				id: 'audit-event-draft',
				eventType: 'draft.revision_created',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: { generation: 1, commitSha: SENT_COMMIT_SHA, changedPaths: ['documents/a.md'] }
			},
			...defaultSteps().slice(1)
		];
		const events = await buildVerifiedAuditChain(CONTEXT, steps);
		const draftEvent = events.find((event) => event.eventType === 'draft.revision_created');
		if (draftEvent === undefined) throw new Error('Expected a draft revision event in the chain');
		draftEvent.payloadJson = JSON.stringify({
			generation: 1,
			commitSha: SENT_COMMIT_SHA,
			changedPaths: ['documents/tampered.md']
		});
		await expect(buildCompletionManifest(await baseInput({ auditEvents: events }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a field row inserted after signing', async () => {
		const fields = [
			...defaultFields(),
			{
				id: 'field-extra',
				fieldType: 'text' as const,
				valueJson: '"x"',
				valueSha256: 'b'.repeat(64)
			}
		];
		await expect(buildCompletionManifest(await baseInput({ fields }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a field row deleted after signing', async () => {
		const fields = defaultFields().slice(0, 1);
		await expect(buildCompletionManifest(await baseInput({ fields }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a field row whose value_sha256 was substituted after signing', async () => {
		const fields = defaultFields().map((field) =>
			field.id === 'field-a' ? { ...field, valueSha256: 'c'.repeat(64) } : field
		);
		await expect(buildCompletionManifest(await baseInput({ fields }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a recipient inserted into evidence that the envelope.ready event never declared', async () => {
		const recipients: CompletionEvidenceRecipient[] = [
			...defaultRecipients('2026-09-13T00:00:00.000Z'),
			{
				id: 'recipient-extra',
				role: 'viewer',
				routingOrder: 1,
				status: 'pending',
				decisionEventId: null,
				decisionOccurredAt: null
			}
		];
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a recipient role that drifted from the envelope.ready declaration', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[1] = { ...recipients[1], role: 'cc' };
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a routing order that drifted from the envelope.ready declaration', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[1] = { ...recipients[1], routingOrder: 2 };
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects an actionable recipient in a completed envelope whose status is not completed', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[0] = { ...recipients[0], status: 'viewed' };
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a non-actionable recipient carrying a signed or approved decision', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[1] = {
			...recipients[1],
			decisionEventId: 'audit-event-2',
			decisionOccurredAt: '2026-09-13T00:00:00.000Z'
		};
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a recipient decision pointing at a mismatched audit event', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[0] = { ...recipients[0], decisionEventId: 'audit-event-1' };
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a recipient decision timestamp that does not match the verified event', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.001Z');
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('rejects a decision timestamp presented without a decision event', async () => {
		const recipients = defaultRecipients('2026-09-13T00:00:00.000Z');
		recipients[1] = { ...recipients[1], decisionOccurredAt: '2026-09-13T00:00:00.000Z' };
		await expect(buildCompletionManifest(await baseInput({ recipients }))).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('accepts a cc/observer recipient with no decision at all', async () => {
		const manifest = await buildCompletionManifest(await baseInput());
		const observer = manifest.recipients.find((recipient) => recipient.id === 'recipient-a');
		expect(observer).toMatchObject({ decisionEventId: null, decisionAt: null });
	});
});

describe('renderCompletionMarkdown', () => {
	it('renders a deterministic Markdown summary containing sorted evidence', async () => {
		const manifest: CompletionManifestV1 = await buildCompletionManifest(await baseInput());
		const markdown: string = renderCompletionMarkdown(manifest);
		expect(markdown).toContain('# Completion evidence — envelope-1');
		expect(markdown).toContain('documents/a.md');
		expect(markdown.indexOf('documents/a.md')).toBeLessThan(markdown.indexOf('documents/b.md'));
		expect(markdown).toContain('recipient-a');
		expect(markdown).toContain('every stored event hash was independently re-derived');
		expect(markdown).toContain('external signed/published anchor');
		expect(renderCompletionMarkdown(manifest)).toBe(markdown);
	});

	it('escapes malformed recipient and field text so the rendered table stays structurally valid', async () => {
		// A pipe or newline in DB text (malformed, but not impossible) must
		// never be able to inject a phantom table column or break a row across
		// two lines — every untrusted table-cell value is escaped consistently.
		const maliciousId: string = 'recipient|evil\ninjected';
		const events = await buildVerifiedAuditChain(CONTEXT, [
			{
				id: 'audit-event-1',
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-10T00:00:00.000Z',
				payload: { title: 'Agreement' }
			},
			{
				id: 'audit-event-ready',
				eventType: 'envelope.ready',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-10T00:00:30.000Z',
				payload: {
					commitSha: SENT_COMMIT_SHA,
					generation: 1,
					recipients: [{ id: maliciousId, role: 'signer', routingOrder: 1 }]
				}
			},
			{
				id: 'audit-event-2',
				eventType: 'recipient.signed',
				actorType: 'recipient',
				actorId: maliciousId,
				occurredAt: '2026-09-13T00:00:00.000Z',
				payload: {
					recipientId: maliciousId,
					role: 'signer',
					routingOrder: 1,
					sentCommitSha: SENT_COMMIT_SHA,
					fields: [{ id: maliciousId, fieldType: 'signature', valueSha256: FIELD_B_SHA256 }],
					signedAt: '2026-09-13T00:00:00.000Z'
				}
			},
			{
				id: 'audit-event-3',
				eventType: 'envelope.completed',
				actorType: 'recipient',
				actorId: maliciousId,
				occurredAt: '2026-09-14T00:00:00.000Z',
				payload: { sentCommitSha: SENT_COMMIT_SHA, completedAt: '2026-09-14T00:00:00.000Z' }
			}
		]);
		const manifest = await buildCompletionManifest({
			envelopeId: ENVELOPE_ID,
			title: 'Agreement',
			sentCommitSha: SENT_COMMIT_SHA,
			draftArchiveSha256: ARCHIVE_SHA256,
			fieldGeneration: 1,
			documents: [{ path: 'documents/a.md', sha256: 'c'.repeat(64) }],
			recipients: [
				{
					id: maliciousId,
					role: 'signer',
					routingOrder: 1,
					status: 'completed',
					decisionEventId: 'audit-event-2',
					decisionOccurredAt: '2026-09-13T00:00:00.000Z'
				}
			],
			fields: [
				{
					id: maliciousId,
					fieldType: 'signature',
					valueJson: '"Signed"',
					valueSha256: FIELD_B_SHA256
				}
			],
			auditEvents: events
		});

		const markdown = renderCompletionMarkdown(manifest);
		expect(markdown).not.toContain(maliciousId);
		expect(markdown).toContain('recipient\\|evil injected');
		const line = markdown.split('\n').find((candidate) => candidate.includes('evil'));
		expect(line).toBeDefined();
		expect(line).toContain('injected');
		expect(line?.startsWith('|')).toBe(true);
	});
});

describe('gzipCompletionArtifact', () => {
	it('produces deterministic gzip output for identical input', () => {
		const first: Uint8Array = gzipCompletionArtifact('hello world');
		const second: Uint8Array = gzipCompletionArtifact('hello world');
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	});

	it('round-trips through gunzip', () => {
		const gzipped: Uint8Array = gzipCompletionArtifact('hello world');
		const decoded: Uint8Array = gunzipSync(gzipped);
		expect(new TextDecoder().decode(decoded)).toBe('hello world');
	});
});
