import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { EnvelopeField } from '$lib/domain/envelope';
import { dateOptionsProperties } from '$lib/domain/signing-date';
import type { PublishFieldPlacementCommand } from '$lib/ports/envelope-field-store';
import { D1EnvelopeApplicationStore } from './d1-envelope-application-store';
import { D1EnvelopeFieldStore } from './d1-envelope-field-store';
import { D1RecipientFieldDeclarationStore } from './d1-recipient-field-declaration-store';
import {
	applyD1MigrationInTransaction,
	applyD1Migrations,
	applyD1MigrationsThrough,
	d1MigrationPaths,
	sqliteD1Database
} from './sqlite-d1-test-support';

const PRIOR: string = 'migrations/d1/0059_instance_display.sql';
const MIGRATION: string = 'migrations/d1/0060_signing_date_mode.sql';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01900000-0000-7000-8000-000000000002';
const TEXT_FIELD_ID: string = '01900000-0000-7000-8000-000000000011';
const DATE_FIELD_ID: string = '01900000-0000-7000-8000-000000000012';
const AUTO_FIELD_ID: string = '01900000-0000-7000-8000-000000000013';
const DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const AT: string = '2026-09-11T00:00:00.000Z';

function seedLegacy(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${AT}', '${AT}');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES ('${ENVELOPE_ID}', 'user-1', 'Agreement', 'ready', 1, '${COMMIT_SHA}', 1, '${AT}', '${AT}');
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
		) VALUES ('${RECIPIENT_ID}', '${ENVELOPE_ID}', 'a@example.com', 'A', 'signer', 'en', 1, 'pending', '${AT}', '${AT}');
		INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, field_type, label, required, position,
			created_at, updated_at
		) VALUES
			('${TEXT_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'text', 'Name', 1, 0, '${AT}', '${AT}'),
			('${DATE_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', '${DOCUMENT_ID}', 'date', 'Date', 1, 1, '${AT}', '${AT}');
		INSERT INTO field_value (
			field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
		) VALUES ('${DATE_FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', 'date', '"2026-09-10"', '${'f'.repeat(64)}', '${AT}');
	`);
}

interface SchemaObject {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

function schemaObjects(sqlite: DatabaseSync, type: 'index' | 'trigger'): SchemaObject[] {
	return sqlite
		.prepare(
			`SELECT type, name, tbl_name, sql FROM sqlite_master
			 WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`
		)
		.all(type) as unknown as SchemaObject[];
}

function foreignKeys(sqlite: DatabaseSync, table: string): unknown[] {
	return sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all();
}

describe('D1 migration 0060 (signing date mode)', () => {
	it('is the next forward-only migration and rebuilds nothing', () => {
		const paths: readonly string[] = d1MigrationPaths();
		expect(paths.indexOf(MIGRATION)).toBe(paths.indexOf(PRIOR) + 1);
		const sql: string = readFileSync(MIGRATION, 'utf8');
		expect(sql).not.toMatch(/DROP\s+TABLE|RENAME\s+TO|CREATE\s+TABLE/i);
		expect(sql).toMatch(/ALTER TABLE envelope_field ADD COLUMN date_mode/);
		expect(sql).toMatch(/ALTER TABLE envelope_field ADD COLUMN date_time_zone/);
	});

	it('upgrades existing data without touching FKs, indexes, or existing triggers', () => {
		const sqlite = new DatabaseSync(':memory:');
		try {
			sqlite.exec('PRAGMA foreign_keys = ON');
			applyD1MigrationsThrough(sqlite, PRIOR);
			seedLegacy(sqlite);
			const indexesBefore = schemaObjects(sqlite, 'index');
			const triggersBefore = schemaObjects(sqlite, 'trigger');
			const fieldFks = foreignKeys(sqlite, 'envelope_field');
			const valueFks = foreignKeys(sqlite, 'field_value');
			const rowsBefore = sqlite
				.prepare('SELECT id, label, field_type FROM envelope_field ORDER BY id')
				.all();

			applyD1MigrationInTransaction(sqlite, MIGRATION);

			expect(schemaObjects(sqlite, 'index')).toEqual(indexesBefore);
			const triggersAfter = schemaObjects(sqlite, 'trigger');
			for (const trigger of triggersBefore) expect(triggersAfter).toContainEqual(trigger);
			expect(
				triggersAfter
					.filter((trigger) => !triggersBefore.some((before) => before.name === trigger.name))
					.map((trigger) => trigger.name)
			).toEqual(['envelope_field_date_options_immutable', 'field_value_automatic_date_guard']);
			expect(foreignKeys(sqlite, 'envelope_field')).toEqual(fieldFks);
			expect(foreignKeys(sqlite, 'field_value')).toEqual(valueFks);
			expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
			expect(
				sqlite.prepare('SELECT id, label, field_type FROM envelope_field ORDER BY id').all()
			).toEqual(rowsBefore);
			expect(sqlite.prepare('SELECT date_mode, date_time_zone FROM envelope_field').all()).toEqual([
				{ date_mode: null, date_time_zone: null },
				{ date_mode: null, date_time_zone: null }
			]);
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM field_value').get()).toEqual({ n: 1 });

			// The composite FK still binds field_value to envelope_field identity.
			expect(() =>
				sqlite
					.prepare(
						`INSERT INTO field_value (field_id, envelope_id, recipient_id, field_type,
							value_json, value_sha256, created_at)
						 VALUES ('missing', ?, ?, 'text', '"x"', ?, ?)`
					)
					.run(ENVELOPE_ID, RECIPIENT_ID, 'a'.repeat(64), AT)
			).toThrow(/FOREIGN KEY/);
			// And legacy inserts that omit both columns keep working.
			sqlite
				.prepare(
					`INSERT INTO field_value (field_id, envelope_id, recipient_id, field_type,
						value_json, value_sha256, created_at)
					 VALUES (?, ?, ?, 'text', '"Alice"', ?, ?)`
				)
				.run(TEXT_FIELD_ID, ENVELOPE_ID, RECIPIENT_ID, 'a'.repeat(64), AT);
		} finally {
			sqlite.close();
		}
	});

	describe('shape checks on a fresh schema', () => {
		let sequence: number = 0;
		const insert = (
			sqlite: DatabaseSync,
			type: string,
			mode: string | null,
			zone: string | null
		): void => {
			sequence += 1;
			sqlite
				.prepare(
					`INSERT INTO envelope_field (
						id, envelope_id, recipient_id, document_id, field_type, label, required, position,
						created_at, updated_at, date_mode, date_time_zone
					) VALUES (?, ?, ?, ?, ?, 'L', 1, ?, ?, ?, ?, ?)`
				)
				.run(
					`01900000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
					ENVELOPE_ID,
					RECIPIENT_ID,
					DOCUMENT_ID,
					type,
					sequence,
					AT,
					AT,
					mode,
					zone
				);
		};

		it('accepts manual and complete automatic shapes and rejects every partial or mismatched one', () => {
			const sqlite = new DatabaseSync(':memory:');
			try {
				applyD1Migrations(sqlite);
				seedLegacyWithoutFields(sqlite);
				insert(sqlite, 'date', null, null);
				insert(sqlite, 'text', null, null);
				insert(sqlite, 'date', 'signed_at', 'Asia/Tokyo');
				for (const [type, mode, zone] of [
					['date', 'signed_at', null],
					['date', null, 'Asia/Tokyo'],
					['text', 'signed_at', 'Asia/Tokyo'],
					['date', 'manual', 'Asia/Tokyo'],
					['date', 'signed_at', ''],
					['date', 'signed_at', 'Z'.repeat(65)]
				] as const) {
					expect(() => insert(sqlite, type, mode, zone)).toThrow(/CHECK constraint/);
				}
			} finally {
				sqlite.close();
			}
		});

		it('freezes options in place but allows the whole-set replace the placement command uses', () => {
			const sqlite = new DatabaseSync(':memory:');
			try {
				applyD1Migrations(sqlite);
				seedLegacyWithoutFields(sqlite);
				sqlite
					.prepare(
						`INSERT INTO envelope_field (
							id, envelope_id, recipient_id, document_id, field_type, label, required, position,
							created_at, updated_at, date_mode, date_time_zone
						) VALUES (?, ?, ?, ?, 'date', 'L', 1, 0, ?, ?, 'signed_at', 'Asia/Tokyo')`
					)
					.run(AUTO_FIELD_ID, ENVELOPE_ID, RECIPIENT_ID, DOCUMENT_ID, AT, AT);
				for (const statement of [
					"UPDATE envelope_field SET date_time_zone = 'UTC'",
					'UPDATE envelope_field SET date_mode = NULL, date_time_zone = NULL'
				]) {
					expect(() => sqlite.exec(statement)).toThrow(/immutable|CHECK/);
				}
				// Unrelated updates stay legal, and DELETE + INSERT replacement works.
				sqlite.exec("UPDATE envelope_field SET label = 'Renamed'");
				sqlite.exec('DELETE FROM envelope_field');
				expect(sqlite.prepare('SELECT COUNT(*) AS n FROM envelope_field').get()).toEqual({ n: 0 });
			} finally {
				sqlite.close();
			}
		});
	});
});

function seedLegacyWithoutFields(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${AT}', '${AT}');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES ('${ENVELOPE_ID}', 'user-1', 'Agreement', 'ready', 1, '${COMMIT_SHA}', 1, '${AT}', '${AT}');
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
		) VALUES ('${RECIPIENT_ID}', '${ENVELOPE_ID}', 'a@example.com', 'A', 'signer', 'en', 1, 'pending', '${AT}', '${AT}');
	`);
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('D1 field placement round trip with automatic date options', () => {
	function command(fields: readonly EnvelopeField[]): PublishFieldPlacementCommand {
		const requestBody: string = JSON.stringify({
			expectedGeneration: 1,
			expectedFieldGeneration: 1,
			fields: fields.map((field) => ({
				recipientId: field.recipientId,
				documentId: field.documentId,
				fieldType: field.fieldType,
				label: field.label,
				required: field.required,
				position: field.position,
				geometry: field.geometry,
				...dateOptionsProperties(field)
			}))
		});
		return {
			envelopeId: ENVELOPE_ID,
			actorType: 'user',
			actorId: 'user-1',
			idempotencyKey: 'place-1',
			requestFingerprint: sha256(requestBody),
			expectedGeneration: 1,
			expectedFieldGeneration: 1,
			expectedCommitSha: COMMIT_SHA,
			fields,
			updatedAt: AT,
			expectedAuditSequence: 1,
			previousAuditHash: 'hash-1',
			auditEventId: '01900000-0000-7000-8000-0000000000aa',
			auditEventHash: 'hash-2',
			auditPayloadJson: JSON.stringify({
				commitSha: COMMIT_SHA,
				generation: 1,
				fieldGeneration: 2,
				fields: fields.map((field) => ({
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
			})
		};
	}

	const geometry = { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
	const base = {
		envelopeId: ENVELOPE_ID,
		recipientId: RECIPIENT_ID,
		documentId: DOCUMENT_ID,
		documentPath: null,
		required: true,
		geometry
	} as const;
	const fields: readonly EnvelopeField[] = [
		{ ...base, id: TEXT_FIELD_ID, fieldType: 'text', label: 'Name', position: 0 },
		{ ...base, id: DATE_FIELD_ID, fieldType: 'date', label: 'Manual date', position: 1 },
		{
			...base,
			id: AUTO_FIELD_ID,
			fieldType: 'date',
			label: 'Signed on',
			position: 2,
			dateMode: 'signed_at',
			dateTimeZone: 'Asia/Tokyo'
		}
	];

	it('persists, reads, replays and projects options only for automatic fields', async () => {
		const sqlite = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedLegacyWithoutFields(sqlite);
			sqlite
				.prepare(
					`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at, hash_version)
					 VALUES (?, ?, 1, 'envelope.ready', 'user', 'user-1', '{}', NULL, 'hash-1', ?, 3)`
				)
				.run('01900000-0000-7000-8000-0000000000a9', ENVELOPE_ID, AT);
			const database = sqliteD1Database(sqlite);
			const store = new D1EnvelopeFieldStore(database);

			const placement = command(fields);
			const published = await store.publishFieldPlacement(placement);
			expect(published.outcome).toBe('published');
			if (published.outcome !== 'published') return;
			const byId = new Map(published.result.fields.map((field) => [field.id, field]));
			expect(byId.get(AUTO_FIELD_ID)).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			// Legacy/manual fields carry no option keys at all.
			expect(Object.keys(byId.get(TEXT_FIELD_ID)!)).not.toContain('dateMode');
			expect(Object.keys(byId.get(DATE_FIELD_ID)!)).not.toContain('dateTimeZone');

			const columns = sqlite
				.prepare('SELECT id, date_mode, date_time_zone FROM envelope_field ORDER BY position')
				.all();
			expect(columns).toEqual([
				{ id: TEXT_FIELD_ID, date_mode: null, date_time_zone: null },
				{ id: DATE_FIELD_ID, date_mode: null, date_time_zone: null },
				{ id: AUTO_FIELD_ID, date_mode: 'signed_at', date_time_zone: 'Asia/Tokyo' }
			]);

			const authoring = await store.readAuthoringFields(ENVELOPE_ID);
			expect(authoring?.fields.find((field) => field.id === AUTO_FIELD_ID)).toMatchObject({
				label: 'Signed on',
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			expect(Object.keys(authoring!.fields[0])).not.toContain('dateMode');

			const detail = await new D1EnvelopeApplicationStore(database).readDetail(ENVELOPE_ID);
			expect(detail?.fields.find((field) => field.id === AUTO_FIELD_ID)).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			expect(Object.keys(detail!.fields[1])).not.toContain('dateMode');

			const own = await new D1RecipientFieldDeclarationStore(database).listOwnFields(
				ENVELOPE_ID,
				RECIPIENT_ID
			);
			expect(own?.fields.find((field) => field.id === AUTO_FIELD_ID)).toMatchObject({
				dateMode: 'signed_at',
				dateTimeZone: 'Asia/Tokyo'
			});
			expect(Object.keys(own!.fields[0])).not.toContain('dateTimeZone');

			// The replay proves its receipt from the durable audit evidence, options included.
			const replay = await store.publishFieldPlacement(placement);
			expect(replay).toMatchObject({ outcome: 'replayed' });
			if (replay.outcome === 'replayed') {
				expect(replay.result.fields.find((field) => field.id === AUTO_FIELD_ID)).toMatchObject({
					dateMode: 'signed_at',
					dateTimeZone: 'Asia/Tokyo'
				});
			}
		} finally {
			sqlite.close();
		}
	});

	it('detects audit-metadata tampering of the frozen options on replay and on authoring reads', async () => {
		const sqlite = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedLegacyWithoutFields(sqlite);
			sqlite
				.prepare(
					`INSERT INTO audit_event (id, envelope_id, sequence, event_type, actor_type, actor_id,
						payload_json, previous_hash, event_hash, occurred_at, hash_version)
					 VALUES (?, ?, 1, 'envelope.ready', 'user', 'user-1', '{}', NULL, 'hash-1', ?, 3)`
				)
				.run('01900000-0000-7000-8000-0000000000a9', ENVELOPE_ID, AT);
			const store = new D1EnvelopeFieldStore(sqliteD1Database(sqlite));
			const placement = command(fields);
			expect((await store.publishFieldPlacement(placement)).outcome).toBe('published');

			// Rewrite the stored command receipt so the zone no longer matches its audit payload.
			sqlite
				.prepare(
					`UPDATE envelope_field_placement_command
					 SET fields_json = REPLACE(fields_json, 'Asia/Tokyo', 'UTC')`
				)
				.run();
			expect(await store.publishFieldPlacement(placement)).toEqual({
				outcome: 'integrity_error'
			});

			// A corrupt option shape in the live projection fails the authoring read closed.
			sqlite.exec('DROP TRIGGER envelope_field_date_options_immutable');
			sqlite.exec('PRAGMA ignore_check_constraints = ON');
			sqlite
				.prepare('UPDATE envelope_field SET date_time_zone = NULL WHERE id = ?')
				.run(AUTO_FIELD_ID);
			await expect(store.readAuthoringFields(ENVELOPE_ID)).rejects.toThrow(
				/date options are corrupt/
			);
		} finally {
			sqlite.close();
		}
	});
});
