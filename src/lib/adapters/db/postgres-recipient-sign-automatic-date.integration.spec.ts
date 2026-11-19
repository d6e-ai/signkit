import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { RecipientSignedApplication } from '$lib/application/signing/recipient-signed';
import { createSigningInstruction } from '$lib/domain/signing-instruction';
import type { EnvelopeSentDocumentStore } from '$lib/ports/envelope-sent-document-store';
import { hashAuditEventV3 } from '$lib/domain/audit';
import type { EnvelopeField } from '$lib/domain/envelope';
import { dateOptionsProperties } from '$lib/domain/signing-date';
import type { PublishFieldPlacementCommand } from '$lib/ports/envelope-field-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import { PostgresEnvelopeFieldStore } from './postgres-envelope-field-store';
import { PostgresRecipientFieldDeclarationStore } from './postgres-recipient-field-declaration-store';
import { PostgresRecipientSignStore } from './postgres-recipient-sign-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;

type Client = ReturnType<typeof postgres>;

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

const TOKEN: string = `skr1_${'C'.repeat(43)}`;
const ENVELOPE_ID: string = '01920003-0000-7000-8000-000000000001';
const SIGNER_ID: string = '01920003-0000-7000-8000-000000000002';
const TEXT_ID: string = '01920003-0000-7000-8000-00000000000b';
const MANUAL_DATE_ID: string = '01920003-0000-7000-8000-00000000000c';
const AUTO_TOKYO_ID: string = '01920003-0000-7000-8000-00000000000d';
const AUTO_UTC_ID: string = '01920003-0000-7000-8000-00000000000e';
const FOREIGN_ID: string = '01920003-0000-7000-8000-0000000000ff';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CREATED_AT: string = '2026-03-29T00:00:00.000Z';
const READY_AT: string = '2026-03-29T12:00:00.000Z';
const PLACED_AT: string = '2026-03-30T00:00:00.000Z';
const SENT_AT: string = '2026-03-30T06:00:00.000Z';
const VIEWED_AT: string = '2026-03-31T10:00:00.000Z';
/** 15:30Z is already the next calendar day in Tokyo and still the same day in UTC. */
const SIGN_INSTANT: string = '2026-03-31T15:30:00.000Z';
const NEXT_DAY_RETRY: string = '2026-04-02T09:00:00.000Z';

const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

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
const AUTO_ONLY: readonly SeedField[] = ALL_FIELDS.slice(2);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Fixture {
	db: Client;
	fieldStore: PostgresEnvelopeFieldStore;
	application: (
		now: string,
		sentDocuments?: EnvelopeSentDocumentStore
	) => RecipientSignedApplication;
}

/** Real placement, then send/view, in an isolated schema that is dropped afterwards. */
async function withFixture(
	fields: readonly SeedField[],
	run: (fixture: Fixture) => Promise<void>
): Promise<void> {
	const schema: string = `signkit_sign_date_${process.pid}_${randomUUID().replaceAll('-', '')}`;
	const db: Client = postgres(TEST_DATABASE_URL as string, {
		max: 2,
		onnotice: (): void => undefined,
		connection: { search_path: schema, TimeZone: 'UTC' }
	});
	try {
		await db.unsafe(`CREATE SCHEMA "${schema}"`);
		await db.unsafe(`SET search_path TO "${schema}"`);
		for (const path of MIGRATION_PATHS) await db.unsafe(readFileSync(path, 'utf8'));
		const capabilityHash: string = await hashRecipientCapability(TOKEN);

		await db`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', ${CREATED_AT}, ${CREATED_AT})`;
		await db`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head,
				repository_archive_key, repository_archive_sha256, field_generation, created_at, updated_at
			) VALUES (${ENVELOPE_ID}, 'user-1', 'Agreement', 'ready', 1, ${COMMIT_SHA},
				'archives/sign-date.git.gz', ${'a'.repeat(64)}, 0, ${CREATED_AT}, ${READY_AT})`;
		await db`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
			) VALUES (${SIGNER_ID}, ${ENVELOPE_ID}, 'alice@example.test', 'Alice', 'signer', 'en', 1,
				'pending', ${CREATED_AT}, ${CREATED_AT})`;

		const readyPayload = { commitSha: COMMIT_SHA, generation: 1 };
		const readyHash: string = await hashAuditEventV3(
			{
				sequence: 1,
				eventType: 'envelope.ready',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: READY_AT,
				payload: readyPayload,
				previousHash: null
			},
			{ envelopeId: ENVELOPE_ID }
		);
		await db`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
				previous_hash, event_hash, occurred_at, hash_version
			) VALUES ('01920003-0000-7000-8000-000000000010', ${ENVELOPE_ID}, 1, 'envelope.ready',
				'user', 'user-1', ${JSON.stringify(readyPayload)}, NULL, ${readyHash}, ${READY_AT}, 3)`;

		// Real placement through the production field store.
		const placed: readonly EnvelopeField[] = fields.map((field): EnvelopeField => ({
			id: field.id,
			envelopeId: ENVELOPE_ID,
			recipientId: SIGNER_ID,
			documentId: null,
			documentPath: 'documents/agreement.md',
			fieldType: field.type,
			label: `Field ${field.position}`,
			required: field.mode === undefined,
			position: field.position,
			geometry: null,
			...(field.mode === undefined ? {} : { dateMode: field.mode, dateTimeZone: field.zone })
		}));
		const placementPayload: string = JSON.stringify({
			commitSha: COMMIT_SHA,
			generation: 1,
			fieldGeneration: 1,
			fields: placed.map((field) => ({
				id: field.id,
				recipientId: field.recipientId,
				documentId: field.documentId,
				documentPath: field.documentPath,
				fieldType: field.fieldType,
				required: field.required,
				position: field.position,
				geometry: field.geometry,
				...dateOptionsProperties(field)
			}))
		});
		const placementHash: string = await hashAuditEventV3(
			{
				sequence: 2,
				eventType: 'envelope.fields_placed',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: PLACED_AT,
				payload: JSON.parse(placementPayload) as unknown,
				previousHash: readyHash
			},
			{ envelopeId: ENVELOPE_ID }
		);
		const fieldStore = new PostgresEnvelopeFieldStore(db);
		const command: PublishFieldPlacementCommand = {
			envelopeId: ENVELOPE_ID,
			actorType: 'user',
			actorId: 'user-1',
			idempotencyKey: 'place-1',
			requestFingerprint: sha256(
				JSON.stringify({
					expectedGeneration: 1,
					expectedFieldGeneration: 0,
					fields: placed.map((field) => ({
						recipientId: field.recipientId,
						documentId: field.documentId,
						fieldType: field.fieldType,
						label: field.label,
						required: field.required,
						position: field.position,
						geometry: field.geometry,
						...dateOptionsProperties(field)
					}))
				})
			),
			expectedGeneration: 1,
			expectedFieldGeneration: 0,
			expectedCommitSha: COMMIT_SHA,
			fields: placed,
			updatedAt: PLACED_AT,
			expectedAuditSequence: 1,
			previousAuditHash: readyHash,
			auditEventId: '01920003-0000-7000-8000-000000000011',
			auditEventHash: placementHash,
			auditPayloadJson: placementPayload
		};
		const published = await fieldStore.publishFieldPlacement(command);
		expect(published.outcome).toBe('published');

		// Send and first view, chained after the placement event.
		await db`UPDATE envelope SET status = 'in_progress', sent_commit_sha = ${COMMIT_SHA},
			updated_at = ${VIEWED_AT} WHERE id = ${ENVELOPE_ID}`;
		await db`UPDATE recipient SET status = 'viewed', capability_hash = ${capabilityHash},
			capability_expires_at = ${'2026-10-08T00:00:00.000Z'}, updated_at = ${VIEWED_AT}
			WHERE id = ${SIGNER_ID}`;
		await db`INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash,
				reserved_capability_expires_at, sealed_capability, sealing_key_id,
				sealed_capability_sha256, available_at, attempts, delivered_at,
				created_at, updated_at, retryable
			) VALUES ('01920003-0000-7000-8000-000000000020', ${ENVELOPE_ID}, ${SIGNER_ID},
				'recipient_invitation', 'delivered', ${capabilityHash}, NULL, NULL, 'key-1',
				${'c'.repeat(64)}, ${SENT_AT}, 1, ${SENT_AT}, ${SENT_AT}, ${SENT_AT}, false)`;
		const sentPayload = { sentCommitSha: COMMIT_SHA };
		const sentHash: string = await hashAuditEventV3(
			{
				sequence: 3,
				eventType: 'envelope.sent',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: SENT_AT,
				payload: sentPayload,
				previousHash: placementHash
			},
			{ envelopeId: ENVELOPE_ID }
		);
		const viewedPayload = {
			recipientId: SIGNER_ID,
			role: 'signer',
			routingOrder: 1,
			sentCommitSha: COMMIT_SHA,
			viewedAt: VIEWED_AT
		};
		const viewedHash: string = await hashAuditEventV3(
			{
				sequence: 4,
				eventType: 'recipient.viewed',
				actorType: 'recipient',
				actorId: SIGNER_ID,
				occurredAt: VIEWED_AT,
				payload: viewedPayload,
				previousHash: sentHash
			},
			{ envelopeId: ENVELOPE_ID }
		);
		await db`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
				previous_hash, event_hash, occurred_at, hash_version
			) VALUES ('01920003-0000-7000-8000-000000000012', ${ENVELOPE_ID}, 3, 'envelope.sent',
				'user', 'user-1', ${JSON.stringify(sentPayload)}, ${placementHash}, ${sentHash}, ${SENT_AT}, 3)`;
		await db`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json,
				previous_hash, event_hash, occurred_at, hash_version
			) VALUES ('01920003-0000-7000-8000-000000000013', ${ENVELOPE_ID}, 4, 'recipient.viewed',
				'recipient', ${SIGNER_ID}, ${JSON.stringify(viewedPayload)}, ${sentHash}, ${viewedHash},
				${VIEWED_AT}, 3)`;

		const signStore = new PostgresRecipientSignStore(db);
		await run({
			db,
			fieldStore,
			application: (now, sentDocuments) =>
				new RecipientSignedApplication(
					signStore,
					() => new Date(now),
					undefined,
					null,
					null,
					sentDocuments
				)
		});
	} finally {
		await db.unsafe(`SET search_path TO public`);
		await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		await db.end({ timeout: 5 });
	}
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

async function storedValues(db: Client): Promise<Record<string, string>> {
	const rows = await db<
		{ fieldId: string; valueJson: string }[]
	>`SELECT field_id AS "fieldId", value_json AS "valueJson" FROM field_value ORDER BY field_id`;
	return Object.fromEntries(rows.map((row) => [row.fieldId, row.valueJson]));
}

async function commandCount(db: Client): Promise<number> {
	const rows = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM recipient_signed_command`;
	return rows[0].n;
}

postgresDescribe('PostgreSQL automatic signing dates (live, isolated schemas)', () => {
	it('persists options through placement and reads them back for authoring, and the signer context', async () => {
		await withFixture(ALL_FIELDS, async ({ db, fieldStore }) => {
			const authoring = await fieldStore.readAuthoringFields(ENVELOPE_ID);
			expect(authoring?.fieldGeneration).toBe(1);
			const byId = new Map(authoring!.fields.map((field) => [field.id, field]));
			expect(byId.get(AUTO_TOKYO_ID)).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			expect(Object.keys(byId.get(TEXT_ID)!)).not.toContain('dateMode');
			expect(Object.keys(byId.get(MANUAL_DATE_ID)!)).not.toContain('dateTimeZone');

			const own = await new PostgresRecipientFieldDeclarationStore(db).listOwnFields(
				ENVELOPE_ID,
				SIGNER_ID
			);
			const ownById = new Map(own!.fields.map((field) => [field.id, field]));
			expect(ownById.get(AUTO_UTC_ID)).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'UTC'
			});
			expect(Object.keys(ownById.get(TEXT_ID)!)).not.toContain('dateMode');
		});
	});

	it('commits explicit instruction evidence once and replays the original signing instant', async () => {
		await withFixture(AUTO_ONLY, async ({ db, application }) => {
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
			const commands = await db<
				{ audit_payload_json: string }[]
			>`SELECT audit_payload_json FROM recipient_signed_command`;
			expect(commands).toHaveLength(1);
			expect(JSON.parse(commands[0].audit_payload_json)).toMatchObject({
				signingInstruction: proof
			});
		});
	});

	it('signs an all-automatic field set with an empty submission and persists each generated value', async () => {
		await withFixture(AUTO_ONLY, async ({ db, application }) => {
			const result = await application(SIGN_INSTANT).sign(input([]));
			expect(result).toMatchObject({ outcome: 'published', result: { signedAt: SIGN_INSTANT } });
			expect(await storedValues(db)).toEqual({
				[AUTO_TOKYO_ID]: JSON.stringify('2026-04-01'),
				[AUTO_UTC_ID]: JSON.stringify('2026-03-31')
			});
			const command = await db<
				{ fieldCount: number; valuesJson: string }[]
			>`SELECT field_count AS "fieldCount", field_values_json AS "valuesJson"
				FROM recipient_signed_command`;
			expect(command[0].fieldCount).toBe(2);
			expect(JSON.parse(command[0].valuesJson)).toHaveLength(2);
			const audit = await db<{ payloadJson: string }[]>`SELECT payload_json AS "payloadJson"
				FROM audit_event WHERE event_type = 'recipient.signed'`;
			expect(audit[0].payloadJson).not.toContain('2026-04-01');
		});
	});

	it('mixes manual and automatic fields, replays on a later day, and conflicts on altered manual input', async () => {
		await withFixture(ALL_FIELDS, async ({ db, application }) => {
			const values = [
				{ fieldId: TEXT_ID, value: 'Alice' },
				{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' }
			];
			const first = await application(SIGN_INSTANT).sign(input(values));
			expect(first.outcome).toBe('published');
			const before = await storedValues(db);
			expect(before[AUTO_TOKYO_ID]).toBe(JSON.stringify('2026-04-01'));
			expect(before[AUTO_UTC_ID]).toBe(JSON.stringify('2026-03-31'));
			expect(before[MANUAL_DATE_ID]).toBe(JSON.stringify('2028-02-29'));

			const replay = await application(NEXT_DAY_RETRY).sign(input(values));
			expect(replay).toMatchObject({ outcome: 'replayed', result: { signedAt: SIGN_INSTANT } });
			expect(await storedValues(db)).toEqual(before);
			expect(await commandCount(db)).toBe(1);

			const conflict = await application(NEXT_DAY_RETRY).sign(
				input([
					{ fieldId: TEXT_ID, value: 'Mallory' },
					{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' }
				])
			);
			expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			expect(await storedValues(db)).toEqual(before);
		});
	});

	it('rejects forged automatic, foreign, and impossible manual submissions without writing anything', async () => {
		await withFixture(ALL_FIELDS, async ({ db, application }) => {
			expect(
				await application(SIGN_INSTANT).sign(
					input([
						{ fieldId: TEXT_ID, value: 'Alice' },
						{ fieldId: MANUAL_DATE_ID, value: '2028-02-29' },
						{ fieldId: AUTO_TOKYO_ID, value: '1999-01-01' }
					])
				)
			).toEqual({ outcome: 'invalid_field' });
			expect(
				await application(SIGN_INSTANT).sign(
					input([
						{ fieldId: TEXT_ID, value: 'Alice' },
						{ fieldId: FOREIGN_ID, value: '2028-02-29' }
					])
				)
			).toEqual({ outcome: 'incomplete_field_set' });
			expect(
				await application(SIGN_INSTANT).sign(
					input([
						{ fieldId: TEXT_ID, value: 'Alice' },
						{ fieldId: MANUAL_DATE_ID, value: '2026-02-29' }
					])
				)
			).toEqual({ outcome: 'invalid_field' });
			expect(await storedValues(db)).toEqual({});
			expect(await commandCount(db)).toBe(0);
		});
	});

	it('freezes options in place and fails closed when they are tampered with after placement', async () => {
		await withFixture(AUTO_ONLY, async ({ db, application }) => {
			await expect(
				db`UPDATE envelope_field SET date_time_zone = 'UTC' WHERE id = ${AUTO_TOKYO_ID}`
			).rejects.toThrow(/immutable/);

			// With the trigger removed the audit-evidence check still refuses to sign.
			await db.unsafe('DROP TRIGGER envelope_field_date_options_immutable ON envelope_field');
			await db`UPDATE envelope_field SET date_time_zone = 'Pacific/Kiritimati'
				WHERE id = ${AUTO_TOKYO_ID}`;
			expect(await application(SIGN_INSTANT).sign(input([]))).toEqual({
				outcome: 'integrity_error'
			});
			await db`UPDATE envelope_field SET date_time_zone = 'Asia/Tokyo' WHERE id = ${AUTO_TOKYO_ID}`;

			// A stripped flag no longer matches the placement evidence either.
			await db`UPDATE envelope_field SET date_mode = NULL, date_time_zone = NULL
				WHERE id = ${AUTO_UTC_ID}`;
			expect(await application(SIGN_INSTANT).sign(input([]))).toEqual({
				outcome: 'integrity_error'
			});
			expect(await storedValues(db)).toEqual({});
		});
	});

	it('rejects a replay whose stored automatic value no longer matches its signing instant', async () => {
		await withFixture(AUTO_ONLY, async ({ db, application }) => {
			expect((await application(SIGN_INSTANT).sign(input([]))).outcome).toBe('published');
			const tampered: string = JSON.stringify('2026-04-02');
			await db.unsafe('DROP TRIGGER field_value_automatic_date_guard ON field_value');
			await db`UPDATE field_value SET value_json = ${tampered}, value_sha256 = ${sha256(tampered)}
				WHERE field_id = ${AUTO_TOKYO_ID}`;
			expect(await application(NEXT_DAY_RETRY).sign(input([]))).toEqual({
				outcome: 'integrity_error'
			});
		});
	});

	it('rejects field_value writes that are not a plausible server date for the instant', async () => {
		await withFixture(AUTO_ONLY, async ({ db }) => {
			const insert = (value: string) =>
				db`INSERT INTO field_value (field_id, envelope_id, recipient_id, field_type, value_json,
					value_sha256, created_at)
					VALUES (${AUTO_TOKYO_ID}, ${ENVELOPE_ID}, ${SIGNER_ID}, 'date', ${value},
						${'e'.repeat(64)}, ${SIGN_INSTANT})`;
			for (const invalid of [
				JSON.stringify(''),
				JSON.stringify('free text'),
				JSON.stringify('2026-02-30'),
				JSON.stringify('2026-04-04'),
				JSON.stringify('2026-03-29')
			]) {
				await expect(insert(invalid)).rejects.toThrow(/automatic date value invalid/);
			}
			await insert(JSON.stringify('2026-04-01'));
		});
	});
});
