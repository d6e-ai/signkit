import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RecipientSignedApplication } from '$lib/application/signing/recipient-signed';
import { createSigningInstruction } from '$lib/domain/signing-instruction';
import type { EnvelopeSentDocumentStore } from '$lib/ports/envelope-sent-document-store';
import { hashAuditEventV3 } from '$lib/domain/audit';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { D1RecipientSignStore } from './d1-recipient-sign-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const SIGNING_INSTRUCTION = { version: 1, locale: 'ja', sentEventHash: '2'.repeat(64) } as const;
const instructionDocuments: EnvelopeSentDocumentStore = {
	findSet: async () => ({
		envelopeId: ENVELOPE_ID,
		commitSha: COMMIT_SHA,
		documentSetHash: '3'.repeat(64),
		documentCount: 0,
		documents: [],
		createdAt: SENT_AT,
		signingInstructionEventHash: SIGNING_INSTRUCTION.sentEventHash
	}),
	findDocument: async () => null
};

const TOKEN: string = `skr1_${'B'.repeat(43)}`;
const ENVELOPE_ID: string = '01920002-0000-7000-8000-000000000001';
const SIGNER_ID: string = '01920002-0000-7000-8000-000000000002';
const TEXT_ID: string = '01920002-0000-7000-8000-00000000000b';
const MANUAL_DATE_ID: string = '01920002-0000-7000-8000-00000000000c';
const AUTO_TOKYO_ID: string = '01920002-0000-7000-8000-00000000000d';
const AUTO_UTC_ID: string = '01920002-0000-7000-8000-00000000000e';
const FOREIGN_ID: string = '01920002-0000-7000-8000-0000000000ff';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const SENT_AT: string = '2026-03-30T00:00:00.000Z';
const VIEWED_AT: string = '2026-03-31T10:00:00.000Z';
/** 15:30Z is already the next calendar day in Tokyo and still the same day in UTC. */
const SIGN_INSTANT: string = '2026-03-31T15:30:00.000Z';
const NEXT_DAY_RETRY: string = '2026-04-02T09:00:00.000Z';

interface SeedField {
	id: string;
	type: 'text' | 'date';
	position: number;
	mode?: 'signed_at';
	zone?: string;
}

const ALL_FIELDS: readonly SeedField[] = [
	{ id: TEXT_ID, type: 'text', position: 0 },
	{ id: MANUAL_DATE_ID, type: 'date', position: 1 },
	{ id: AUTO_TOKYO_ID, type: 'date', position: 2, mode: 'signed_at', zone: 'Asia/Tokyo' },
	{ id: AUTO_UTC_ID, type: 'date', position: 3, mode: 'signed_at', zone: 'UTC' }
];

async function seed(fields: readonly SeedField[]): Promise<{
	sqlite: DatabaseSync;
	application: (
		now: string,
		sentDocuments?: EnvelopeSentDocumentStore
	) => RecipientSignedApplication;
}> {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const capabilityHash: string = await hashRecipientCapability(TOKEN);

	const placementPayload = {
		commitSha: COMMIT_SHA,
		generation: 1,
		fieldGeneration: 1,
		fields: fields.map((field) => ({
			id: field.id,
			recipientId: SIGNER_ID,
			documentId: null,
			documentPath: 'documents/agreement.md',
			fieldType: field.type,
			required: field.mode === undefined,
			position: field.position,
			geometry: null,
			...(field.mode === undefined ? {} : { dateMode: field.mode, dateTimeZone: field.zone })
		}))
	};
	const events = [
		{
			id: '01920002-0000-7000-8000-000000000010',
			type: 'envelope.fields_placed',
			actor: 'user',
			actorId: 'user-1',
			payload: placementPayload,
			at: SENT_AT
		},
		{
			id: '01920002-0000-7000-8000-000000000011',
			type: 'envelope.sent',
			actor: 'user',
			actorId: 'user-1',
			payload: { sentCommitSha: COMMIT_SHA },
			at: SENT_AT
		},
		{
			id: '01920002-0000-7000-8000-000000000012',
			type: 'recipient.viewed',
			actor: 'recipient',
			actorId: SIGNER_ID,
			payload: {
				recipientId: SIGNER_ID,
				role: 'signer',
				routingOrder: 1,
				sentCommitSha: COMMIT_SHA,
				viewedAt: VIEWED_AT
			},
			at: VIEWED_AT
		}
	];

	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES ('user-1', 'owner', 'active', ?, ?)`
		)
		.run(SENT_AT, SENT_AT);
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, sent_commit_sha,
				field_generation, created_at, updated_at
			) VALUES (?, 'user-1', 'Agreement', 'in_progress', 1, ?, 'archives/x.git.gz', ?, ?, 1, ?, ?)`
		)
		.run(ENVELOPE_ID, COMMIT_SHA, 'a'.repeat(64), COMMIT_SHA, SENT_AT, VIEWED_AT);
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, created_at, updated_at
			) VALUES (?, ?, 'alice@example.test', 'Alice', 'signer', 'en', 1, 'viewed', ?, ?, ?, ?)`
		)
		.run(SIGNER_ID, ENVELOPE_ID, capabilityHash, '2026-10-08T00:00:00.000Z', SENT_AT, VIEWED_AT);
	for (const field of fields) {
		sqlite
			.prepare(
				`INSERT INTO envelope_field (
					id, envelope_id, recipient_id, document_path, field_type, label,
					required, position, created_at, updated_at, date_mode, date_time_zone
				) VALUES (?, ?, ?, 'documents/agreement.md', ?, 'Field', ?, ?, ?, ?, ?, ?)`
			)
			.run(
				field.id,
				ENVELOPE_ID,
				SIGNER_ID,
				field.type,
				field.mode === undefined ? 1 : 0,
				field.position,
				SENT_AT,
				SENT_AT,
				field.mode ?? null,
				field.zone ?? null
			);
	}
	sqlite
		.prepare(
			`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES (?, ?, ?, 'recipient_invitation', 'delivered', ?, NULL, NULL, 'key-1', ?, ?, 1, ?, ?, ?, 0)`
		)
		.run(
			'01920002-0000-7000-8000-000000000020',
			ENVELOPE_ID,
			SIGNER_ID,
			capabilityHash,
			'c'.repeat(64),
			SENT_AT,
			SENT_AT,
			SENT_AT,
			SENT_AT
		);

	let previousHash: string | null = null;
	for (const [index, event] of events.entries()) {
		const eventHash: string = await hashAuditEventV3(
			{
				sequence: index + 1,
				eventType: event.type,
				actorType: event.actor,
				actorId: event.actorId,
				occurredAt: event.at,
				payload: event.payload,
				previousHash
			},
			{ envelopeId: ENVELOPE_ID }
		);
		sqlite
			.prepare(
				`INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
					previous_hash, event_hash, occurred_at, hash_version
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3)`
			)
			.run(
				event.id,
				ENVELOPE_ID,
				index + 1,
				event.type,
				event.actor,
				event.actorId,
				JSON.stringify(event.payload),
				previousHash,
				eventHash,
				event.at
			);
		previousHash = eventHash;
	}

	const store = new D1RecipientSignStore(sqliteD1Database(sqlite));
	return {
		sqlite,
		application: (now, sentDocuments) =>
			new RecipientSignedApplication(
				store,
				() => new Date(now),
				undefined,
				null,
				null,
				sentDocuments
			)
	};
}

function input(values: readonly { fieldId: string; value: string | boolean }[], key = 'sign-1') {
	return {
		token: TOKEN,
		expectedEnvelopeId: ENVELOPE_ID,
		expectedRecipientId: SIGNER_ID,
		expectedFieldGeneration: 1,
		idempotencyKey: key,
		values
	};
}

function storedValues(sqlite: DatabaseSync): Record<string, string> {
	const rows = sqlite
		.prepare('SELECT field_id, value_json FROM field_value ORDER BY field_id')
		.all() as { field_id: string; value_json: string }[];
	return Object.fromEntries(rows.map((row) => [row.field_id, row.value_json]));
}

describe('D1 automatic signing dates (real SQLite, migrated schema)', () => {
	it('commits explicit instruction evidence once and replays the original signing instant', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS.slice(2));
		try {
			const app = application(SIGN_INSTANT, instructionDocuments);
			expect(await app.sign(input([]))).toEqual({ outcome: 'signing_instruction_conflict' });
			const submission = { ...input([]), signingInstruction: SIGNING_INSTRUCTION };
			const signed = await app.sign(submission);
			if (signed.outcome !== 'published') throw new Error('Expected the instruction to publish');
			const proof = await createSigningInstruction(SIGNING_INSTRUCTION, 1);
			expect(signed.result).toMatchObject({ signedAt: SIGN_INSTANT, signingInstruction: proof });
			const retry = application(NEXT_DAY_RETRY, instructionDocuments);
			expect(await retry.sign(submission)).toEqual({ outcome: 'replayed', result: signed.result });
			expect(
				await retry.sign({
					...submission,
					signingInstruction: { ...SIGNING_INSTRUCTION, locale: 'en' }
				})
			).toEqual({ outcome: 'idempotency_conflict' });
			const command = sqlite
				.prepare('SELECT audit_payload_json FROM recipient_signed_command')
				.all();
			expect(command).toHaveLength(1);
			expect(JSON.parse(command[0].audit_payload_json as string)).toMatchObject({
				signingInstruction: proof
			});
		} finally {
			sqlite.close();
		}
	});

	it('signs an all-automatic field set with an empty submission and persists each generated value', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS.slice(2));
		const result = await application(SIGN_INSTANT).sign(input([]));
		expect(result).toMatchObject({ outcome: 'published', result: { signedAt: SIGN_INSTANT } });
		expect(storedValues(sqlite)).toEqual({
			[AUTO_TOKYO_ID]: JSON.stringify('2026-04-01'),
			[AUTO_UTC_ID]: JSON.stringify('2026-03-31')
		});
		const command = sqlite
			.prepare('SELECT field_count, updated_at, field_values_json FROM recipient_signed_command')
			.get() as { field_count: number; updated_at: string; field_values_json: string };
		expect(command.field_count).toBe(2);
		expect(command.updated_at).toBe(SIGN_INSTANT);
		expect(JSON.parse(command.field_values_json)).toHaveLength(2);
		// The audit trail digests the generated values; the values themselves are not echoed.
		const audit = sqlite
			.prepare("SELECT payload_json FROM audit_event WHERE event_type = 'recipient.signed'")
			.get() as { payload_json: string };
		expect(audit.payload_json).not.toContain('2026-04-01');
		expect(JSON.parse(audit.payload_json).fields).toHaveLength(2);
	});

	it('mixes manual and automatic fields and replays on a later day with the original instant and date', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS);
		const values = [
			{ fieldId: TEXT_ID, value: 'Alice' },
			{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' }
		];
		const first = await application(SIGN_INSTANT).sign(input(values));
		expect(first.outcome).toBe('published');
		const before = storedValues(sqlite);
		expect(before[AUTO_TOKYO_ID]).toBe(JSON.stringify('2026-04-01'));
		expect(before[MANUAL_DATE_ID]).toBe(JSON.stringify('2028-02-29'));

		const replay = await application(NEXT_DAY_RETRY).sign(input(values));
		expect(replay).toMatchObject({ outcome: 'replayed', result: { signedAt: SIGN_INSTANT } });
		expect(storedValues(sqlite)).toEqual(before);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM recipient_signed_command').get()).toEqual({
			n: 1
		});

		// Different manual values under the same key conflict; nothing is rewritten.
		const conflict = await application(NEXT_DAY_RETRY).sign(
			input([
				{ fieldId: TEXT_ID, value: 'Mallory' },
				{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' }
			])
		);
		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
		expect(storedValues(sqlite)).toEqual(before);
	});

	it('rejects a forged automatic-date submission and mutates nothing', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS);
		const forged = await application(SIGN_INSTANT).sign(
			input([
				{ fieldId: TEXT_ID, value: 'Alice' },
				{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' },
				{ fieldId: AUTO_TOKYO_ID, value: '1999-01-01' }
			])
		);
		expect(forged).toEqual({ outcome: 'invalid_field' });
		const foreign = await application(SIGN_INSTANT).sign(
			input([
				{ fieldId: TEXT_ID, value: 'Alice' },
				{ fieldId: FOREIGN_ID, value: '2028-02-29' }
			])
		);
		expect(foreign).toEqual({ outcome: 'incomplete_field_set' });
		expect(storedValues(sqlite)).toEqual({});
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM recipient_signed_command').get()).toEqual({
			n: 0
		});
	});

	it('rejects an impossible manual calendar date next to automatic fields', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS);
		const result = await application(SIGN_INSTANT).sign(
			input([
				{ fieldId: TEXT_ID, value: 'Alice' },
				{ fieldId: MANUAL_DATE_ID, value: '2026-02-29' }
			])
		);
		expect(result).toEqual({ outcome: 'invalid_field' });
		expect(storedValues(sqlite)).toEqual({});
	});

	it('fails closed when the frozen time zone is modified after placement', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS.slice(2));
		// The immutability trigger blocks the edit outright...
		expect(() =>
			sqlite
				.prepare("UPDATE envelope_field SET date_time_zone = 'UTC' WHERE id = ?")
				.run(AUTO_TOKYO_ID)
		).toThrow(/immutable/);
		// ...and even with that guard removed, the audit-evidence check still refuses to sign.
		sqlite.exec('DROP TRIGGER envelope_field_date_options_immutable');
		sqlite
			.prepare("UPDATE envelope_field SET date_time_zone = 'Pacific/Kiritimati' WHERE id = ?")
			.run(AUTO_TOKYO_ID);
		expect(await application(SIGN_INSTANT).sign(input([]))).toEqual({
			outcome: 'integrity_error'
		});
		expect(storedValues(sqlite)).toEqual({});
	});

	it('fails closed when an automatic flag is stripped or invented after placement', async () => {
		const stripped = await seed(ALL_FIELDS.slice(2));
		stripped.sqlite.exec('DROP TRIGGER envelope_field_date_options_immutable');
		stripped.sqlite
			.prepare('UPDATE envelope_field SET date_mode = NULL, date_time_zone = NULL WHERE id = ?')
			.run(AUTO_UTC_ID);
		expect(await stripped.application(SIGN_INSTANT).sign(input([]))).toEqual({
			outcome: 'integrity_error'
		});

		const invented = await seed([{ id: MANUAL_DATE_ID, type: 'date', position: 0 }]);
		invented.sqlite.exec('DROP TRIGGER envelope_field_date_options_immutable');
		invented.sqlite
			.prepare(
				"UPDATE envelope_field SET date_mode = 'signed_at', date_time_zone = 'UTC' WHERE id = ?"
			)
			.run(MANUAL_DATE_ID);
		expect(await invented.application(SIGN_INSTANT).sign(input([]))).toEqual({
			outcome: 'integrity_error'
		});
	});

	it('rejects a replay whose stored automatic value no longer matches its signing instant', async () => {
		const { sqlite, application } = await seed(ALL_FIELDS.slice(2));
		expect((await application(SIGN_INSTANT).sign(input([]))).outcome).toBe('published');
		// Value tampering must also keep the stored digest consistent to reach the date proof.
		const tampered: string = JSON.stringify('2026-04-02');
		const digest: string = createHash('sha256').update(tampered).digest('hex');
		sqlite.exec('DROP TRIGGER IF EXISTS field_value_automatic_date_guard');
		sqlite
			.prepare('UPDATE field_value SET value_json = ?, value_sha256 = ? WHERE field_id = ?')
			.run(tampered, digest, AUTO_TOKYO_ID);
		expect(await application(NEXT_DAY_RETRY).sign(input([]))).toEqual({
			outcome: 'integrity_error'
		});
	});

	it('rejects field_value writes that are not a plausible server date for the instant', async () => {
		const { sqlite } = await seed(ALL_FIELDS.slice(2));
		const insert = (value: string, createdAt: string = SIGN_INSTANT): void => {
			sqlite
				.prepare(
					`INSERT INTO field_value (field_id, envelope_id, recipient_id, field_type,
						value_json, value_sha256, created_at) VALUES (?, ?, ?, 'date', ?, ?, ?)`
				)
				.run(AUTO_TOKYO_ID, ENVELOPE_ID, SIGNER_ID, value, 'e'.repeat(64), createdAt);
		};
		for (const invalid of [
			JSON.stringify(''),
			JSON.stringify('free text'),
			JSON.stringify('2026-02-30'),
			JSON.stringify('2026-04-04'),
			JSON.stringify('2026-03-29'),
			'2026-04-01'
		]) {
			expect(() => insert(invalid)).toThrow(/automatic date value invalid/);
		}
		expect(() => insert(JSON.stringify('2026-04-01'))).not.toThrow();
	});
});
