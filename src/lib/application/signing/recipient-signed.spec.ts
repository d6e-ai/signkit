import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	PublishRecipientSignedCommand,
	RecipientSignStore,
	SignPreparation,
	SignRoutingSnapshot
} from '$lib/ports/recipient-sign-store';
import { canonicalRecipientSignFingerprint } from '$lib/ports/recipient-sign-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { InvalidSignInputError, RecipientSignedApplication } from './recipient-signed';

const token: string = `skr1_${'A'.repeat(43)}`;
const organizationId: string = 'org-1';
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const fieldId: string = '01910000-0000-7000-8000-000000000003';

function routing(overrides: Partial<SignRoutingSnapshot> = {}): SignRoutingSnapshot {
	return {
		currentGroupOutstanding: 1,
		remainingActionableOutstanding: 2,
		nextRoutingOrder: null,
		nextGroupCount: 0,
		...overrides
	};
}

function ready(overrides: Partial<SignPreparation & { outcome: 'ready' }> = {}): SignPreparation {
	return {
		outcome: 'ready',
		organizationId,
		envelopeId,
		recipientId,
		recipientRole: 'signer',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		fieldGeneration: 1,
		envelopeStatus: 'in_progress',
		auditHead: { sequence: 3, eventHash: 'audit-head-3' },
		routing: routing(),
		fields: [{ id: fieldId, fieldType: 'text', required: true }],
		...overrides
	};
}

function store(
	preparations: SignPreparation[] = [ready()],
	publishResults: Array<Awaited<ReturnType<RecipientSignStore['publishSign']>>> = []
): RecipientSignStore & {
	prepareSign: ReturnType<typeof vi.fn>;
	publishSign: ReturnType<typeof vi.fn>;
} {
	return {
		prepareSign: vi.fn(
			async (): Promise<SignPreparation> => preparations.shift() ?? { outcome: 'integrity_error' }
		),
		publishSign: vi.fn(
			async (command: PublishRecipientSignedCommand) =>
				publishResults.shift() ?? {
					outcome: 'published' as const,
					result: {
						envelopeId: command.expectedEnvelopeId,
						recipientId: command.expectedRecipientId,
						recipientRole: command.recipientRole,
						routingOrder: command.routingOrder,
						sentCommitSha: command.expectedSentCommitSha,
						envelopeStatus:
							command.completedAuditEventId === null
								? ('in_progress' as const)
								: ('completed' as const),
						signedAt: command.updatedAt,
						auditEventId: command.auditEventId,
						completedAuditEventId: command.completedAuditEventId,
						nextRoutingOrder: command.nextRoutingOrder
					}
				}
		)
	};
}

const input = {
	token,
	expectedEnvelopeId: envelopeId,
	expectedRecipientId: recipientId,
	expectedFieldGeneration: 1,
	idempotencyKey: 'sign-browser-tab-1',
	values: [{ fieldId, value: 'Jane Doe' }]
};

async function expectedFingerprint(
	value: string | boolean = 'Jane Doe',
	generation: number = 1
): Promise<string> {
	const capabilityHash: string = await hashRecipientCapability(token);
	return createHash('sha256')
		.update(
			canonicalRecipientSignFingerprint({
				envelopeId,
				recipientId,
				capabilityHash,
				expectedFieldGeneration: generation,
				values: [{ fieldId, value }]
			})
		)
		.digest('hex');
}

describe('RecipientSignedApplication', () => {
	it('publishes a PII-free, digest-only signed command without a release or completion', async () => {
		const storePort = store();
		const result = await new RecipientSignedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).sign(input);

		expect(result.outcome).toBe('published');
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command).toMatchObject({
			expectedEnvelopeId: envelopeId,
			expectedRecipientId: recipientId,
			idempotencyKey: input.idempotencyKey,
			recipientRole: 'signer',
			routingOrder: 1,
			expectedFieldGeneration: 1,
			expectedAuditSequence: 3,
			previousAuditHash: 'audit-head-3',
			updatedAt: '2026-09-11T00:02:00.000Z',
			nextRoutingOrder: null,
			nextCapabilityExpiresAt: null,
			releasedDeliveryCount: 0,
			completedAuditEventId: null,
			completedAuditEventHash: null,
			completedAuditPayloadJson: null
		});
		expect(command.fieldValues).toHaveLength(1);
		expect(command.fieldValues[0].fieldId).toBe(fieldId);
		expect(command.fieldValues[0].valueJson).toBe(JSON.stringify('Jane Doe'));
		expect(command.fieldValues[0].valueSha256).toBe(
			createHash('sha256').update(JSON.stringify('Jane Doe')).digest('hex')
		);
		const auditPayload = JSON.parse(command.auditPayloadJson);
		expect(auditPayload).toEqual({
			recipientId,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			fields: [{ id: fieldId, fieldType: 'text', valueSha256: command.fieldValues[0].valueSha256 }],
			signedAt: '2026-09-11T00:02:00.000Z'
		});
		expect(command.auditPayloadJson).not.toMatch(/Jane Doe|recipient@example|skr1_/);
	});

	it('computes a stable capability-bound request fingerprint over normalized values and field generation', async () => {
		const storePort = store();
		await new RecipientSignedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).sign(input);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.requestFingerprint).toBe(await expectedFingerprint());
		expect(command.expectedFieldGeneration).toBe(1);
		expect(storePort.prepareSign.mock.calls[0][0]).not.toHaveProperty('requestFingerprint');
	});

	it('hashes equivalent submissions identically regardless of value order or surrounding whitespace', async () => {
		const secondFieldId: string = '01910000-0000-7000-8000-000000000004';
		const twoFields: SignPreparation = ready({
			fields: [
				{ id: fieldId, fieldType: 'text', required: true },
				{ id: secondFieldId, fieldType: 'text', required: true }
			]
		});
		const first = store([twoFields]);
		await new RecipientSignedApplication(first, () => new Date('2026-09-11T00:02:00.000Z')).sign({
			...input,
			values: [
				{ fieldId: secondFieldId, value: '  Beta  ' },
				{ fieldId, value: '  Jane Doe  ' }
			]
		});
		const second = store([
			ready({
				fields: [
					{ id: fieldId, fieldType: 'text', required: true },
					{ id: secondFieldId, fieldType: 'text', required: true }
				]
			})
		]);
		await new RecipientSignedApplication(second, () => new Date('2026-09-11T00:02:00.000Z')).sign({
			...input,
			values: [
				{ fieldId, value: 'Jane Doe' },
				{ fieldId: secondFieldId, value: 'Beta' }
			]
		});
		expect(first.publishSign.mock.calls[0][0].requestFingerprint).toBe(
			second.publishSign.mock.calls[0][0].requestFingerprint
		);
		expect(first.publishSign.mock.calls[0][0].fieldValues[0].valueJson).toBe(
			JSON.stringify('Jane Doe')
		);
	});

	it('rejects a stale expectedFieldGeneration before publishing', async () => {
		const storePort = store([ready({ fieldGeneration: 2 })]);
		await expect(
			new RecipientSignedApplication(storePort).sign({ ...input, expectedFieldGeneration: 1 })
		).resolves.toEqual({ outcome: 'field_generation_conflict' });
		expect(storePort.publishSign).not.toHaveBeenCalled();
	});

	it('releases the next routing group with a bounded future capability expiry when the current group clears', async () => {
		const storePort = store([
			ready({
				routing: routing({ currentGroupOutstanding: 0, nextRoutingOrder: 2, nextGroupCount: 2 })
			})
		]);
		await new RecipientSignedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).sign(input);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.nextRoutingOrder).toBe(2);
		expect(command.releasedDeliveryCount).toBe(2);
		expect(command.completedAuditEventId).toBeNull();
		expect(Date.parse(command.nextCapabilityExpiresAt as string)).toBeGreaterThan(
			Date.parse(command.updatedAt)
		);
	});

	it('appends a deterministic envelope.completed event chained onto the signed hash when no non-CC recipients remain', async () => {
		const storePort = store([
			ready({ routing: routing({ currentGroupOutstanding: 0, remainingActionableOutstanding: 0 }) })
		]);
		await new RecipientSignedApplication(
			storePort,
			() => new Date('2026-09-11T00:02:00.000Z')
		).sign(input);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.nextRoutingOrder).toBeNull();
		expect(command.releasedDeliveryCount).toBe(0);
		expect(command.completedAuditEventId).not.toBeNull();
		expect(command.completedAuditEventId).not.toBe(command.auditEventId);
		expect(JSON.parse(command.completedAuditPayloadJson as string)).toEqual({
			sentCommitSha: 'a'.repeat(40),
			completedAt: '2026-09-11T00:02:00.000Z'
		});
		const expectedCompletedHash: string = createHash('sha256')
			.update(
				JSON.stringify({
					actorId: recipientId,
					envelopeId,
					eventType: 'envelope.completed',
					occurredAt: '2026-09-11T00:02:00.000Z',
					organizationId,
					payload: { sentCommitSha: 'a'.repeat(40), completedAt: '2026-09-11T00:02:00.000Z' },
					previousHash: command.auditEventHash
				})
			)
			.digest('hex');
		expect(command.completedAuditEventHash).toBe(expectedCompletedHash);
	});

	it('rejects an unknown field ID that this recipient did not declare as an incomplete set', async () => {
		// Swapping in an unrecognized field ID leaves the one truly declared
		// field unanswered, so this is indistinguishable from an incomplete set.
		const storePort = store();
		await expect(
			new RecipientSignedApplication(storePort).sign({
				...input,
				values: [{ fieldId: '01910000-0000-7000-8000-000000000099', value: 'x' }]
			})
		).resolves.toEqual({ outcome: 'incomplete_field_set' });
		expect(storePort.publishSign).not.toHaveBeenCalled();
	});

	it('rejects a wrong-type value for a declared field', async () => {
		const storePort = store();
		await expect(
			new RecipientSignedApplication(storePort).sign({
				...input,
				values: [{ fieldId, value: true }]
			})
		).resolves.toEqual({ outcome: 'invalid_field' });
	});

	it('rejects an incomplete declared field set', async () => {
		const storePort = store([
			ready({
				fields: [
					{ id: fieldId, fieldType: 'text', required: true },
					{ id: '01910000-0000-7000-8000-000000000004', fieldType: 'checkbox', required: false }
				]
			})
		]);
		await expect(new RecipientSignedApplication(storePort).sign(input)).resolves.toEqual({
			outcome: 'incomplete_field_set'
		});
		expect(storePort.publishSign).not.toHaveBeenCalled();
	});

	it('rejects a missing required value even when the declared set is otherwise complete', async () => {
		const storePort = store();
		await expect(
			new RecipientSignedApplication(storePort).sign({ ...input, values: [{ fieldId, value: '' }] })
		).resolves.toEqual({ outcome: 'missing_required_value' });
	});

	it('accepts an empty value for a non-required field', async () => {
		const storePort = store([
			ready({ fields: [{ id: fieldId, fieldType: 'text', required: false }] })
		]);
		await expect(
			new RecipientSignedApplication(storePort).sign({ ...input, values: [{ fieldId, value: '' }] })
		).resolves.toMatchObject({ outcome: 'published' });
	});

	it('publishes the exact empty set for a signer with no assigned fields', async () => {
		const storePort = store([ready({ fields: [] })]);
		await expect(
			new RecipientSignedApplication(storePort).sign({ ...input, values: [] })
		).resolves.toMatchObject({ outcome: 'published' });
		expect(storePort.publishSign.mock.calls[0][0].fieldValues).toEqual([]);
		expect(JSON.parse(storePort.publishSign.mock.calls[0][0].auditPayloadJson).fields).toEqual([]);
	});

	it('validates a strict YYYY-MM-DD calendar date and rejects malformed or impossible dates', async () => {
		const dateFieldPreparation = (): SignPreparation =>
			ready({ fields: [{ id: fieldId, fieldType: 'date', required: true }] });

		await expect(
			new RecipientSignedApplication(store([dateFieldPreparation()])).sign({
				...input,
				values: [{ fieldId, value: '2026-09-11' }]
			})
		).resolves.toMatchObject({ outcome: 'published' });
		await expect(
			new RecipientSignedApplication(store([dateFieldPreparation()])).sign({
				...input,
				values: [{ fieldId, value: '0001-01-01' }]
			})
		).resolves.toMatchObject({ outcome: 'published' });
		await expect(
			new RecipientSignedApplication(store([dateFieldPreparation()])).sign({
				...input,
				values: [{ fieldId, value: '2000-02-29' }]
			})
		).resolves.toMatchObject({ outcome: 'published' });

		for (const value of ['1900-02-29', '2026-13-01', '2026-02-30', 'not-a-date', '09/11/2026']) {
			await expect(
				new RecipientSignedApplication(store([dateFieldPreparation()])).sign({
					...input,
					values: [{ fieldId, value }]
				})
			).resolves.toEqual({ outcome: 'invalid_field' });
		}
	});

	it('treats a required checkbox as missing when false and satisfied when true', async () => {
		const checkboxPreparation = (): SignPreparation =>
			ready({ fields: [{ id: fieldId, fieldType: 'checkbox', required: true }] });

		await expect(
			new RecipientSignedApplication(store([checkboxPreparation()])).sign({
				...input,
				values: [{ fieldId, value: false }]
			})
		).resolves.toEqual({ outcome: 'missing_required_value' });

		await expect(
			new RecipientSignedApplication(store([checkboxPreparation()])).sign({
				...input,
				values: [{ fieldId, value: true }]
			})
		).resolves.toMatchObject({ outcome: 'published' });
	});

	it.each([
		[
			'too many values',
			Array.from({ length: 51 }, (_, index) => ({ fieldId: String(index), value: 'x' }))
		],
		['an invalid field ID', [{ fieldId: 'not-a-uuid', value: 'x' }]],
		[
			'a duplicate field ID',
			[
				{ fieldId, value: 'a' },
				{ fieldId, value: 'b' }
			]
		]
	])('throws InvalidSignInputError for %s', async (_label, values) => {
		await expect(
			new RecipientSignedApplication(store()).sign({ ...input, values })
		).rejects.toBeInstanceOf(InvalidSignInputError);
	});

	it('does not call the store again once a replay is found, and skips publication', async () => {
		const receipt = {
			envelopeId,
			recipientId,
			recipientRole: 'signer' as const,
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			envelopeStatus: 'in_progress' as const,
			signedAt: '2026-09-11T00:01:00.000Z',
			auditEventId: 'audit-signed',
			completedAuditEventId: null,
			nextRoutingOrder: null
		};
		const storePort = store([
			{
				outcome: 'existing',
				reconstructedFingerprint: await expectedFingerprint(),
				result: receipt,
				storedFields: [{ id: fieldId, fieldType: 'text', required: false }]
			}
		]);
		await expect(new RecipientSignedApplication(storePort).sign(input)).resolves.toEqual({
			outcome: 'replayed',
			result: receipt
		});
		expect(storePort.prepareSign).toHaveBeenCalledTimes(1);
		expect(storePort.publishSign).not.toHaveBeenCalled();
	});

	it('treats an existing command with a different normalized payload as an idempotency conflict', async () => {
		const storePort = store([
			{
				outcome: 'existing',
				reconstructedFingerprint: await expectedFingerprint('Other Person'),
				result: {
					envelopeId,
					recipientId,
					recipientRole: 'signer',
					routingOrder: 1,
					sentCommitSha: 'a'.repeat(40),
					envelopeStatus: 'in_progress',
					signedAt: '2026-09-11T00:01:00.000Z',
					auditEventId: 'audit-signed',
					completedAuditEventId: null,
					nextRoutingOrder: null
				},
				storedFields: [{ id: fieldId, fieldType: 'text', required: false }]
			}
		]);
		await expect(new RecipientSignedApplication(storePort).sign(input)).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
		expect(storePort.publishSign).not.toHaveBeenCalled();
	});

	it('passes through terminal preparation outcomes without publishing', async () => {
		for (const outcome of ['not_found', 'context_mismatch', 'role_not_actionable'] as const) {
			const storePort = store([{ outcome }]);
			await expect(new RecipientSignedApplication(storePort).sign(input)).resolves.toEqual({
				outcome
			});
			expect(storePort.publishSign).not.toHaveBeenCalled();
		}
	});

	it('retries bounded audit-head races with a fresh non-regressing signed timestamp', async () => {
		const secondReady: SignPreparation = ready({
			auditHead: { sequence: 4, eventHash: 'audit-head-4' }
		});
		const storePort = store([ready(), secondReady], [{ outcome: 'audit_conflict' }]);
		const timestamps: Date[] = [
			new Date('2026-09-11T00:02:00.000Z'),
			new Date('2026-09-11T00:02:01.000Z'),
			new Date('2026-09-11T00:02:02.000Z')
		];
		await expect(
			new RecipientSignedApplication(
				storePort,
				() => timestamps.shift() ?? new Date('2026-09-11T00:02:02.000Z')
			).sign(input)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(storePort.publishSign).toHaveBeenCalledTimes(2);
		const commands: PublishRecipientSignedCommand[] = storePort.publishSign.mock.calls.map(
			(call): PublishRecipientSignedCommand => call[0]
		);
		expect(commands.map((command): string => command.updatedAt)).toEqual([
			'2026-09-11T00:02:00.000Z',
			'2026-09-11T00:02:01.000Z'
		]);
		expect(commands[1].previousAuditHash).toBe('audit-head-4');
	});

	it('returns the terminal audit conflict once retries are exhausted', async () => {
		const storePort = store(
			[ready(), ready(), ready()],
			[{ outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }, { outcome: 'audit_conflict' }]
		);
		await expect(new RecipientSignedApplication(storePort).sign(input)).resolves.toEqual({
			outcome: 'audit_conflict'
		});
		expect(storePort.prepareSign).toHaveBeenCalledTimes(3);
		expect(storePort.publishSign).toHaveBeenCalledTimes(3);
	});
});
