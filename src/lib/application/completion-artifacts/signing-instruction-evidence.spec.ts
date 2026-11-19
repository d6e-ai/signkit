import { describe, expect, it, vi } from 'vitest';
import type {
	CompletionEvidenceAuditEvent,
	CompletionEvidenceField,
	CompletionEvidenceRecipient
} from '$lib/ports/completion-artifact-store';
import { buildVerifiedAuditChain, type AuditChainStep } from './audit-chain-test-support';
import {
	buildCompletionManifest,
	canonicalManifestJson,
	renderCompletionMarkdown,
	type BuildCompletionManifestInput
} from './completion-manifest';

/**
 * The real domain readers are owned by the parent integration. These stand-ins
 * keep this spec's contract explicit: `null` for malformed/unrecognized or a
 * text digest that does not verify (BAD_TEXT_SHA256), `undefined` when absent.
 */
const BAD_TEXT_SHA256: string = 'e'.repeat(64);
vi.mock('$lib/domain/signing-instruction', () => ({
	readSigningInstruction: async (payload: unknown): Promise<unknown> => {
		const instruction: unknown = (payload as Record<string, unknown>).signingInstruction;
		if (instruction === undefined) return undefined;
		const candidate = instruction as Record<string, unknown>;
		if (candidate.version !== 1 || candidate.textSha256 === BAD_TEXT_SHA256) return null;
		return instruction;
	}
}));
vi.mock('$lib/domain/commands/sent-signing-instruction', () => ({
	sentSigningInstructionVersion: (payload: Record<string, unknown>): 1 | undefined | null => {
		const version: unknown = payload.signingInstructionVersion;
		return version === undefined ? undefined : version === 1 ? 1 : null;
	}
}));

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const COMMIT: string = 'a'.repeat(40);
const OTHER_COMMIT: string = 'b'.repeat(40);
const TEXT_EN: string = '1'.repeat(64);
const TEXT_JA: string = '2'.repeat(64);
const PDF_ONE: string = '3'.repeat(64);
const PDF_TWO: string = '4'.repeat(64);
const SIG_SHA: string = '5'.repeat(64);
const DATE_SHA: string = '6'.repeat(64);
const CONTEXT = { envelopeId: ENVELOPE_ID };

interface Options {
	marked?: boolean;
	sentVersion?: unknown;
	mutateInstruction?: (recipientId: string, instruction: Record<string, unknown>) => void;
	omitInstructionFor?: string;
	extraSigned?: boolean;
	generation?: number;
	signedCommit?: string;
}

function sentPayload(marked: boolean, version: unknown): Record<string, unknown> {
	return {
		commitSha: COMMIT,
		readyAuditEventId: 'ready',
		documentSetHash: '7'.repeat(64),
		documentCount: 2,
		documents: [
			{ id: 'doc-1', sha256: PDF_TWO, byteSize: 10, pageCount: 1 },
			{ id: 'doc-2', sha256: PDF_ONE, byteSize: 10, pageCount: 1 }
		],
		...(marked ? { signingInstructionVersion: version } : {})
	};
}

function steps(options: Options, sentEventHash: string): AuditChainStep[] {
	const marked: boolean = options.marked ?? true;
	const generation: number = options.generation ?? 3;
	const signed = (id: string, recipientId: string, order: number, at: string, locale: string) => {
		const instruction: Record<string, unknown> = {
			version: 1,
			locale,
			sentEventHash,
			textSha256: locale === 'ja' ? TEXT_JA : TEXT_EN,
			fieldGeneration: generation
		};
		options.mutateInstruction?.(recipientId, instruction);
		return {
			id,
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: recipientId,
			occurredAt: at,
			payload: {
				recipientId,
				role: 'signer',
				routingOrder: order,
				sentCommitSha: options.signedCommit ?? COMMIT,
				fields: [
					{
						id: `field-${recipientId}`,
						fieldType: 'signature',
						valueSha256: recipientId === 'signer-1' ? SIG_SHA : DATE_SHA
					}
				],
				signedAt: at,
				...(marked && options.omitInstructionFor !== recipientId
					? { signingInstruction: instruction }
					: {})
			}
		};
	};
	return [
		{
			id: 'ready',
			eventType: 'envelope.ready',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:00.000Z',
			payload: {
				commitSha: COMMIT,
				generation: 1,
				recipients: [
					{ id: 'signer-1', role: 'signer', routingOrder: 1 },
					{ id: 'signer-2', role: 'signer', routingOrder: 2 },
					{ id: 'approver-1', role: 'approver', routingOrder: 3 }
				]
			}
		},
		{
			id: 'sent',
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:10.000Z',
			payload: sentPayload(marked, options.sentVersion ?? 1)
		},
		signed('signed-1', 'signer-1', 1, '2026-09-11T00:00:00.000Z', 'en'),
		signed('signed-2', 'signer-2', 2, '2026-09-12T00:00:00.000Z', 'ja'),
		...(options.extraSigned
			? [signed('signed-x', 'approver-1', 3, '2026-09-12T12:00:00.000Z', 'en')]
			: []),
		{
			id: 'approved',
			eventType: 'recipient.approved',
			actorType: 'recipient',
			actorId: 'approver-1',
			occurredAt: '2026-09-13T00:00:00.000Z',
			payload: { recipientId: 'approver-1' }
		},
		{
			id: 'completed',
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: 'approver-1',
			occurredAt: '2026-09-14T00:00:00.000Z',
			payload: { sentCommitSha: COMMIT, completedAt: '2026-09-14T00:00:00.000Z' }
		}
	];
}

/** Two passes: the signed payloads must reference the sent event's real hash. */
async function chain(options: Options = {}): Promise<CompletionEvidenceAuditEvent[]> {
	const first = await buildVerifiedAuditChain(CONTEXT, steps(options, '0'.repeat(64)));
	const sentHash: string = first[1].eventHash;
	return buildVerifiedAuditChain(CONTEXT, steps(options, sentHash));
}

function recipients(): CompletionEvidenceRecipient[] {
	return [
		{
			id: 'signer-1',
			role: 'signer',
			routingOrder: 1,
			status: 'completed',
			decisionEventId: 'signed-1',
			decisionOccurredAt: '2026-09-11T00:00:00.000Z'
		},
		{
			id: 'signer-2',
			role: 'signer',
			routingOrder: 2,
			status: 'completed',
			decisionEventId: 'signed-2',
			decisionOccurredAt: '2026-09-12T00:00:00.000Z'
		},
		{
			id: 'approver-1',
			role: 'approver',
			routingOrder: 3,
			status: 'completed',
			decisionEventId: 'approved',
			decisionOccurredAt: '2026-09-13T00:00:00.000Z'
		}
	];
}

const FIELDS: CompletionEvidenceField[] = [
	{ id: 'field-signer-1', fieldType: 'signature', valueJson: '"x"', valueSha256: SIG_SHA },
	{ id: 'field-signer-2', fieldType: 'signature', valueJson: '"y"', valueSha256: DATE_SHA }
];

async function input(options: Options = {}): Promise<BuildCompletionManifestInput> {
	return {
		envelopeId: ENVELOPE_ID,
		title: 'Agreement',
		sentCommitSha: COMMIT,
		draftArchiveSha256: '8'.repeat(64),
		fieldGeneration: options.generation ?? 3,
		documents: [{ path: 'documents/a.md', sha256: '9'.repeat(64) }],
		recipients: recipients(),
		fields: FIELDS,
		auditEvents: await chain(options)
	};
}

describe('signing instruction completion evidence', () => {
	it('records verified per-party instructions and ordered sent PDF digests for a multi-party send', async () => {
		const events = await chain();
		const manifest = await buildCompletionManifest({ ...(await input()), auditEvents: events });
		const evidence = manifest.signingInstructions!;
		expect(evidence.sentEventHash).toBe(events[1].eventHash);
		expect(evidence.sentCommitSha).toBe(COMMIT);
		expect(evidence.sentPdfSha256).toEqual([PDF_TWO, PDF_ONE]);
		expect(evidence.parties.map((party) => party.recipientId)).toEqual(['signer-1', 'signer-2']);
		expect(evidence.parties.map((party) => party.signingInstruction.locale)).toEqual(['en', 'ja']);
		expect(evidence.parties[1]).toMatchObject({
			decisionEventId: 'signed-2',
			signedAt: '2026-09-12T00:00:00.000Z',
			signingInstruction: { textSha256: TEXT_JA, sentEventHash: events[1].eventHash }
		});
		expect(Object.keys(manifest).at(-1)).toBe('signingInstructions');
		expect(renderCompletionMarkdown(manifest)).toContain('## Signing instructions');
		expect(canonicalManifestJson(manifest)).toBe(canonicalManifestJson(manifest));
	});

	it('keeps legacy sends byte-identical: no marker, no evidence key or section', async () => {
		const manifest = await buildCompletionManifest(await input({ marked: false }));
		expect(manifest.signingInstructions).toBeUndefined();
		expect(canonicalManifestJson(manifest)).not.toContain('signingInstruction');
		expect(renderCompletionMarkdown(manifest)).not.toContain('Signing instructions');
		expect(Object.keys(manifest)).toEqual([
			'schema',
			'envelopeId',
			'title',
			'sentCommitSha',
			'draftArchiveSha256',
			'fieldGeneration',
			'completedAt',
			'documents',
			'recipients',
			'fields',
			'auditProof'
		]);
	});

	it('rejects a legacy send whose signature claims an instruction', async () => {
		const options: Options = { marked: false };
		const events = await buildVerifiedAuditChain(
			CONTEXT,
			steps(options, '0'.repeat(64)).map((step) =>
				step.id === 'signed-1'
					? {
							...step,
							payload: {
								...(step.payload as object),
								signingInstruction: { version: 1 }
							}
						}
					: step
			)
		);
		await expect(
			buildCompletionManifest({ ...(await input(options)), auditEvents: events })
		).rejects.toThrow(/did not mark/);
	});

	it.each([
		['a missing instruction on one signer', { omitInstructionFor: 'signer-2' }, /does not match the exact/],
		[
			'an instruction bound to a different send event',
			{
				mutateInstruction: (id: string, instruction: Record<string, unknown>) => {
					if (id === 'signer-2') instruction.sentEventHash = 'f'.repeat(64);
				}
			},
			/exact envelope\.sent/
		],
		[
			'a text digest that does not verify',
			{
				mutateInstruction: (id: string, instruction: Record<string, unknown>) => {
					if (id === 'signer-1') instruction.textSha256 = BAD_TEXT_SHA256;
				}
			},
			/exact envelope\.sent/
		],
		[
			'a different field generation',
			{
				mutateInstruction: (id: string, instruction: Record<string, unknown>) => {
					if (id === 'signer-1') instruction.fieldGeneration = 2;
				}
			},
			/exact envelope\.sent/
		],
		[
			'a cross-version instruction',
			{
				mutateInstruction: (_id: string, instruction: Record<string, unknown>) => {
					instruction.version = 2;
				}
			},
			/exact envelope\.sent/
		],
		['an unrecognized send marker', { sentVersion: 2 }, /marker is invalid/],
		['a signed event from a non-signer', { extraSigned: true }, /not a named signer/]
	] satisfies [string, Options, RegExp][])('fails closed on %s', async (_name, options, message) => {
		await expect(buildCompletionManifest(await input(options))).rejects.toThrow(message);
	});

	it('rejects a decision pointer that names another signer event', async () => {
		const base = await input();
		const swapped = recipients();
		swapped[0] = { ...swapped[0], decisionEventId: 'signed-2' };
		await expect(buildCompletionManifest({ ...base, recipients: swapped })).rejects.toThrow();
	});

	it('rejects field digests that differ from the signed payload', async () => {
		const base = await input();
		await expect(
			buildCompletionManifest({
				...base,
				fields: [{ ...FIELDS[0], valueSha256: '0'.repeat(64) }, FIELDS[1]]
			})
		).rejects.toThrow();
	});

	it('rejects a signed event pinned to a different commit', async () => {
		await expect(buildCompletionManifest(await input({ signedCommit: OTHER_COMMIT }))).rejects.toThrow(
			/does not match its named signer and send/
		);
	});
});
