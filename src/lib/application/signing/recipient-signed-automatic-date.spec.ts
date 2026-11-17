import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
	PublishRecipientSignedCommand,
	PublishedRecipientSigned,
	RecipientSignStore,
	SignPreparation,
	SignableFieldDeclaration
} from '$lib/ports/recipient-sign-store';
import { canonicalRecipientSignFingerprint } from '$lib/ports/recipient-sign-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { InvalidSignInputError, RecipientSignedApplication } from './recipient-signed';

const token: string = `skr1_${'A'.repeat(43)}`;
const envelopeId: string = '01910000-0000-7000-8000-000000000001';
const recipientId: string = '01910000-0000-7000-8000-000000000002';
const textId: string = '01910000-0000-7000-8000-000000000003';
const manualDateId: string = '01910000-0000-7000-8000-000000000004';
const autoTokyoId: string = '01910000-0000-7000-8000-000000000005';
const autoUtcId: string = '01910000-0000-7000-8000-000000000006';
const foreignId: string = '01910000-0000-7000-8000-0000000000ff';

const text: SignableFieldDeclaration = { id: textId, fieldType: 'text', required: true };
const manualDate: SignableFieldDeclaration = {
	id: manualDateId,
	fieldType: 'date',
	required: true
};
const autoTokyo: SignableFieldDeclaration = {
	id: autoTokyoId,
	fieldType: 'date',
	required: true,
	dateMode: 'signed_at',
	dateTimeZone: 'Asia/Tokyo'
};
const autoUtc: SignableFieldDeclaration = {
	id: autoUtcId,
	fieldType: 'date',
	required: false,
	dateMode: 'signed_at',
	dateTimeZone: 'UTC'
};

function ready(fields: readonly SignableFieldDeclaration[]): SignPreparation {
	return {
		outcome: 'ready',
		envelopeId,
		recipientId,
		recipientRole: 'signer',
		routingOrder: 1,
		sentCommitSha: 'a'.repeat(40),
		fieldGeneration: 1,
		envelopeStatus: 'in_progress',
		auditHead: { sequence: 3, eventHash: 'audit-head-3' },
		routing: {
			currentGroupOutstanding: 1,
			remainingActionableOutstanding: 2,
			nextRoutingOrder: null,
			nextGroupCount: 0
		},
		fields
	};
}

function store(
	preparations: SignPreparation[],
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
						envelopeStatus: 'in_progress' as const,
						signedAt: command.updatedAt,
						auditEventId: command.auditEventId,
						completedAuditEventId: command.completedAuditEventId,
						nextRoutingOrder: command.nextRoutingOrder
					}
				}
		)
	};
}

function baseInput(values: readonly { fieldId: string; value: string | boolean }[]) {
	return {
		token,
		expectedEnvelopeId: envelopeId,
		expectedRecipientId: recipientId,
		expectedFieldGeneration: 1,
		idempotencyKey: 'sign-tab-1',
		values
	};
}

async function fingerprint(
	values: readonly { fieldId: string; value: string | boolean }[]
): Promise<string> {
	return createHash('sha256')
		.update(
			canonicalRecipientSignFingerprint({
				envelopeId,
				recipientId,
				capabilityHash: await hashRecipientCapability(token),
				expectedFieldGeneration: 1,
				values
			})
		)
		.digest('hex');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const at = (iso: string) => () => new Date(iso);

describe('automatic signing dates', () => {
	it('generates a value and hash for every automatic field when the submitted values are empty', async () => {
		const storePort = store([ready([autoTokyo, autoUtc])]);
		const result = await new RecipientSignedApplication(
			storePort,
			at('2026-03-31T15:30:00.000Z')
		).sign(baseInput([]));
		expect(result.outcome).toBe('published');
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.fieldValues).toEqual([
			{
				fieldId: autoTokyoId,
				fieldType: 'date',
				valueJson: JSON.stringify('2026-04-01'),
				valueSha256: sha(JSON.stringify('2026-04-01')),
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			},
			{
				fieldId: autoUtcId,
				fieldType: 'date',
				valueJson: JSON.stringify('2026-03-31'),
				valueSha256: sha(JSON.stringify('2026-03-31')),
				dateMode: 'signed_at',
				dateTimeZone: 'UTC'
			}
		]);
		// The request fingerprint covers client input only: here, none.
		expect(command.requestFingerprint).toBe(await fingerprint([]));
		expect(command.updatedAt).toBe('2026-03-31T15:30:00.000Z');
		const payload = JSON.parse(command.auditPayloadJson) as {
			fields: { id: string; fieldType: string; valueSha256: string }[];
		};
		expect(payload.fields).toEqual([
			{ id: autoTokyoId, fieldType: 'date', valueSha256: sha(JSON.stringify('2026-04-01')) },
			{ id: autoUtcId, fieldType: 'date', valueSha256: sha(JSON.stringify('2026-03-31')) }
		]);
	});

	it('persists manual and generated values together while fingerprinting only the manual ones', async () => {
		const storePort = store([ready([text, manualDate, autoTokyo])]);
		await new RecipientSignedApplication(storePort, at('2026-03-31T15:30:00.000Z')).sign(
			baseInput([
				{ fieldId: manualDateId, value: '2028-02-29' },
				{ fieldId: textId, value: ' Jane ' }
			])
		);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.fieldValues.map((value) => value.fieldId)).toEqual([
			textId,
			manualDateId,
			autoTokyoId
		]);
		expect(command.fieldValues[1].valueJson).toBe(JSON.stringify('2028-02-29'));
		expect(command.fieldValues[2].valueJson).toBe(JSON.stringify('2026-04-01'));
		expect(command.fieldValues[0]).not.toHaveProperty('dateMode');
		expect(command.fieldValues[1]).not.toHaveProperty('dateTimeZone');
		expect(command.requestFingerprint).toBe(
			await fingerprint([
				{ fieldId: textId, value: 'Jane' },
				{ fieldId: manualDateId, value: '2028-02-29' }
			])
		);
	});

	it('rejects a forged submission for an automatic date field before any mutation', async () => {
		for (const values of [
			[{ fieldId: autoTokyoId, value: '1999-01-01' }],
			[
				{ fieldId: textId, value: 'Jane' },
				{ fieldId: autoTokyoId, value: '2026-04-01' }
			],
			[{ fieldId: autoTokyoId, value: '' }]
		]) {
			const storePort = store([ready([text, autoTokyo])]);
			await expect(
				new RecipientSignedApplication(storePort, at('2026-03-31T15:30:00.000Z')).sign(
					baseInput(values)
				)
			).resolves.toEqual({ outcome: 'invalid_field' });
			expect(storePort.publishSign).not.toHaveBeenCalled();
		}
	});

	it('rejects foreign, missing and duplicate manual IDs before mutation', async () => {
		const foreign = store([ready([text, autoTokyo])]);
		await expect(
			new RecipientSignedApplication(foreign).sign(
				baseInput([{ fieldId: foreignId, value: 'Jane' }])
			)
		).resolves.toEqual({ outcome: 'incomplete_field_set' });

		const missing = store([ready([text, manualDate, autoTokyo])]);
		await expect(
			new RecipientSignedApplication(missing).sign(baseInput([{ fieldId: textId, value: 'Jane' }]))
		).resolves.toEqual({ outcome: 'incomplete_field_set' });

		const duplicate = store([ready([text, autoTokyo])]);
		await expect(
			new RecipientSignedApplication(duplicate).sign(
				baseInput([
					{ fieldId: textId, value: 'a' },
					{ fieldId: textId, value: 'b' }
				])
			)
		).rejects.toBeInstanceOf(InvalidSignInputError);

		for (const port of [foreign, missing, duplicate]) {
			expect(port.publishSign).not.toHaveBeenCalled();
		}
	});

	it('keeps real-calendar validation for manual dates', async () => {
		const accepted = store([ready([manualDate, autoUtc])]);
		await expect(
			new RecipientSignedApplication(accepted, at('2026-03-31T15:30:00.000Z')).sign(
				baseInput([{ fieldId: manualDateId, value: '2028-02-29' }])
			)
		).resolves.toMatchObject({ outcome: 'published' });
		for (const invalid of ['2026-02-29', '2100-02-29', '2026-13-01', '2026-04-31']) {
			const rejected = store([ready([manualDate, autoUtc])]);
			await expect(
				new RecipientSignedApplication(rejected).sign(
					baseInput([{ fieldId: manualDateId, value: invalid }])
				)
			).resolves.toEqual({ outcome: 'invalid_field' });
			expect(rejected.publishSign).not.toHaveBeenCalled();
		}
	});

	it('derives the date from the server instant, not any client-supplied clock', async () => {
		const storePort = store([ready([autoUtc])]);
		await new RecipientSignedApplication(storePort, at('2030-12-31T23:59:59.999Z')).sign(
			baseInput([])
		);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(command.fieldValues[0].valueJson).toBe(JSON.stringify('2030-12-31'));
		expect(command.updatedAt).toBe('2030-12-31T23:59:59.999Z');
	});

	it('re-derives the date with the new instant when an audit-head conflict forces a retry across midnight', async () => {
		const storePort = store([ready([autoUtc]), ready([autoUtc])], [{ outcome: 'audit_conflict' }]);
		const instants: string[] = ['2026-03-31T23:59:59.900Z', '2026-04-01T00:00:00.100Z'];
		const result = await new RecipientSignedApplication(
			storePort,
			() => new Date(instants.shift()!)
		).sign(baseInput([]));
		expect(result.outcome).toBe('published');
		const [first, second]: PublishRecipientSignedCommand[] = storePort.publishSign.mock.calls.map(
			(call) => call[0]
		);
		expect(first.fieldValues[0].valueJson).toBe(JSON.stringify('2026-03-31'));
		expect(second.fieldValues[0].valueJson).toBe(JSON.stringify('2026-04-01'));
		expect(second.updatedAt).toBe('2026-04-01T00:00:00.100Z');
		// Each attempt is internally consistent: payload hash == value hash == instant.
		for (const command of [first, second]) {
			expect(JSON.parse(command.auditPayloadJson).signedAt).toBe(command.updatedAt);
		}
	});

	describe('replay on a later day', () => {
		const receipt: PublishedRecipientSigned = {
			envelopeId,
			recipientId,
			recipientRole: 'signer',
			routingOrder: 1,
			sentCommitSha: 'a'.repeat(40),
			envelopeStatus: 'in_progress',
			signedAt: '2026-03-31T23:59:00.000Z',
			auditEventId: 'audit-signed',
			completedAuditEventId: null,
			nextRoutingOrder: null
		};

		it('returns the original receipt without regenerating from the retry-time clock', async () => {
			const storePort = store([
				{
					outcome: 'existing',
					reconstructedFingerprint: await fingerprint([{ fieldId: textId, value: 'Jane' }]),
					result: receipt,
					// The adapter lists only the editable fields.
					storedFields: [{ id: textId, fieldType: 'text', required: false }]
				}
			]);
			await expect(
				new RecipientSignedApplication(storePort, at('2026-04-02T10:00:00.000Z')).sign(
					baseInput([{ fieldId: textId, value: 'Jane' }])
				)
			).resolves.toEqual({ outcome: 'replayed', result: receipt });
			expect(storePort.publishSign).not.toHaveBeenCalled();
		});

		it('replays an all-automatic command with an empty submission', async () => {
			const storePort = store([
				{
					outcome: 'existing',
					reconstructedFingerprint: await fingerprint([]),
					result: receipt,
					storedFields: []
				}
			]);
			await expect(
				new RecipientSignedApplication(storePort, at('2026-04-02T10:00:00.000Z')).sign(
					baseInput([])
				)
			).resolves.toEqual({ outcome: 'replayed', result: receipt });
		});

		it('conflicts when the same key is retried with different manual values or a forged automatic ID', async () => {
			const stored = {
				outcome: 'existing' as const,
				reconstructedFingerprint: await fingerprint([{ fieldId: textId, value: 'Jane' }]),
				result: receipt,
				storedFields: [{ id: textId, fieldType: 'text' as const, required: false }]
			};
			await expect(
				new RecipientSignedApplication(store([{ ...stored }]), at('2026-04-02T10:00:00.000Z')).sign(
					baseInput([{ fieldId: textId, value: 'Other' }])
				)
			).resolves.toEqual({ outcome: 'idempotency_conflict' });
			await expect(
				new RecipientSignedApplication(store([{ ...stored }]), at('2026-04-02T10:00:00.000Z')).sign(
					baseInput([
						{ fieldId: textId, value: 'Jane' },
						{ fieldId: autoTokyoId, value: '2026-04-02' }
					])
				)
			).resolves.toEqual({ outcome: 'idempotency_conflict' });
		});
	});

	it('leaves legacy submissions byte-identical: no options on values and the historical fingerprint', async () => {
		const storePort = store([ready([text])]);
		await new RecipientSignedApplication(storePort, at('2026-03-31T15:30:00.000Z')).sign(
			baseInput([{ fieldId: textId, value: 'Jane' }])
		);
		const command: PublishRecipientSignedCommand = storePort.publishSign.mock.calls[0][0];
		expect(Object.keys(command.fieldValues[0])).toEqual([
			'fieldId',
			'fieldType',
			'valueJson',
			'valueSha256'
		]);
		expect(command.requestFingerprint).toBe(
			await fingerprint([{ fieldId: textId, value: 'Jane' }])
		);
	});
});
