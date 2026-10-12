import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { EnvelopeStatus } from '$lib/domain/envelope';
import { D1EnvelopeApplicationStore } from './d1-envelope-application-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const USER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const RECIPIENT_A: string = '01900000-0000-7000-8000-000000000002';
const RECIPIENT_B: string = '01900000-0000-7000-8000-000000000003';
const READY_AUDIT_ID: string = '01900000-0000-7000-8000-000000000033';
const PDF_DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000021';
const CREATED_AT: string = '2026-09-11T00:00:00.000Z';

interface InstrumentedD1 {
	database: D1Database;
	firstCalls: number;
	batchCalls: number;
	batchSizes: number[];
	armFirstHook(hook: () => void): void;
}

function instrumentedD1(sqlite: DatabaseSync): InstrumentedD1 {
	const delegate: D1Database = sqliteD1Database(sqlite);
	let firstCalls: number = 0;
	let batchCalls: number = 0;
	const batchSizes: number[] = [];
	let firstHook: (() => void) | null = null;

	function patchStatement(statement: D1PreparedStatement): D1PreparedStatement {
		const originalBind: D1PreparedStatement['bind'] = statement.bind.bind(statement);
		const originalFirst: D1PreparedStatement['first'] = statement.first.bind(statement);
		statement.bind = (...bindings: unknown[]): D1PreparedStatement => {
			return patchStatement(originalBind(...bindings));
		};
		statement.first = (async <T>(colName?: string): Promise<T | null> => {
			firstCalls += 1;
			if (firstHook !== null) firstHook();
			if (colName === undefined) return originalFirst<T>();
			return originalFirst<T>(colName);
		}) as D1PreparedStatement['first'];
		return statement;
	}

	const database: D1Database = {
		prepare: (sql: string): D1PreparedStatement => patchStatement(delegate.prepare(sql)),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			batchCalls += 1;
			batchSizes.push(statements.length);
			return delegate.batch<T>(statements);
		}
	} as unknown as D1Database;

	return {
		database,
		get firstCalls(): number {
			return firstCalls;
		},
		get batchCalls(): number {
			return batchCalls;
		},
		batchSizes,
		armFirstHook: (hook: () => void): void => {
			firstHook = hook;
		}
	};
}

function seedMember(sqlite: DatabaseSync): void {
	sqlite
		.prepare(
			`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			 VALUES (?, 'owner', 'active', ?, ?)`
		)
		.run(USER_ID, CREATED_AT, CREATED_AT);
}

function seedEnvelope(sqlite: DatabaseSync, status: EnvelopeStatus = 'ready'): void {
	sqlite
		.prepare(
			`INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, field_generation,
				created_at, updated_at
			) VALUES (?, ?, 'Agreement', ?, 1, 1, ?, ?)`
		)
		.run(ENVELOPE_ID, USER_ID, status, CREATED_AT, CREATED_AT);
}

function seedRecipient(
	sqlite: DatabaseSync,
	id: string,
	email: string,
	routingOrder: number
): void {
	sqlite
		.prepare(
			`INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status,
				created_at, updated_at
			) VALUES (?, ?, ?, 'Signer', 'signer', 'en', ?, 'pending', ?, ?)`
		)
		.run(id, ENVELOPE_ID, email, routingOrder, CREATED_AT, CREATED_AT);
}

function seedReadyAudit(sqlite: DatabaseSync): void {
	sqlite
		.prepare(
			`INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id,
				payload_json, previous_hash, event_hash, occurred_at, hash_version
			) VALUES (?, ?, 2, 'envelope.ready', 'user', ?, '{}', 'hash-1', 'hash-2', ?, 3)`
		)
		.run(READY_AUDIT_ID, ENVELOPE_ID, USER_ID, CREATED_AT);
}

function seedMixedFields(sqlite: DatabaseSync): void {
	const insert = sqlite.prepare(
		`INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, 'signature', 'Signature', 1, ?, ?, ?)`
	);
	insert.run(
		'01900000-0000-7000-8000-000000000012',
		ENVELOPE_ID,
		RECIPIENT_A,
		null,
		'documents/agreement.md',
		1,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000011',
		ENVELOPE_ID,
		RECIPIENT_A,
		PDF_DOCUMENT_ID,
		null,
		1,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000014',
		ENVELOPE_ID,
		RECIPIENT_A,
		PDF_DOCUMENT_ID,
		null,
		0,
		CREATED_AT,
		CREATED_AT
	);
	insert.run(
		'01900000-0000-7000-8000-000000000013',
		ENVELOPE_ID,
		RECIPIENT_A,
		null,
		'documents/appendix.md',
		0,
		CREATED_AT,
		CREATED_AT
	);
}

describe('D1EnvelopeApplicationStore readDetail sqlite integration', () => {
	it('reads a coherent mixed Markdown/PDF snapshot in one batch and never calls first()', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedMember(sqlite);
			seedEnvelope(sqlite, 'ready');
			seedRecipient(sqlite, RECIPIENT_B, 'b@example.com', 2);
			seedRecipient(sqlite, RECIPIENT_A, 'a@example.com', 1);
			seedReadyAudit(sqlite);
			seedMixedFields(sqlite);
			const instrumented: InstrumentedD1 = instrumentedD1(sqlite);
			instrumented.armFirstHook((): void => {
				sqlite.exec(`DELETE FROM envelope_field WHERE envelope_id = '${ENVELOPE_ID}'`);
			});
			const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(
				instrumented.database
			);

			const detail = await store.readDetail(ENVELOPE_ID);

			expect(detail?.envelope.id).toBe(ENVELOPE_ID);
			expect(detail?.envelope.status).toBe('ready');
			expect(detail?.readyAuditEventId).toBe(READY_AUDIT_ID);
			expect(detail?.recipients.map((recipient): string => recipient.id)).toEqual([
				RECIPIENT_A,
				RECIPIENT_B
			]);
			expect(detail?.fields.map((field): string => field.id)).toEqual([
				'01900000-0000-7000-8000-000000000014',
				'01900000-0000-7000-8000-000000000011',
				'01900000-0000-7000-8000-000000000012',
				'01900000-0000-7000-8000-000000000013'
			]);
			expect(instrumented.batchCalls).toBe(1);
			expect(instrumented.batchSizes).toEqual([4]);
			expect(instrumented.firstCalls).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it('returns null for a missing envelope and ignores a stale ready audit on draft', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedMember(sqlite);
			const instrumented: InstrumentedD1 = instrumentedD1(sqlite);
			const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(
				instrumented.database
			);
			await expect(store.readDetail(ENVELOPE_ID)).resolves.toBeNull();
			expect(instrumented.batchCalls).toBe(1);
			expect(instrumented.firstCalls).toBe(0);

			seedEnvelope(sqlite, 'draft');
			seedRecipient(sqlite, RECIPIENT_A, 'a@example.com', 1);
			seedReadyAudit(sqlite);
			const draft = await store.readDetail(ENVELOPE_ID);
			expect(draft?.envelope.status).toBe('draft');
			expect(draft?.readyAuditEventId).toBeNull();
			expect(instrumented.batchCalls).toBe(2);
			expect(instrumented.firstCalls).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it('does not observe a first()-hooked field delete because detail uses the local sqlite batch shim, not deployed D1 timing', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			seedMember(sqlite);
			seedEnvelope(sqlite, 'sent');
			seedRecipient(sqlite, RECIPIENT_A, 'a@example.com', 1);
			seedReadyAudit(sqlite);
			seedMixedFields(sqlite);
			const instrumented: InstrumentedD1 = instrumentedD1(sqlite);
			let hooked: boolean = false;
			instrumented.armFirstHook((): void => {
				hooked = true;
				sqlite.exec(`DELETE FROM envelope_field WHERE envelope_id = '${ENVELOPE_ID}'`);
			});
			const store: D1EnvelopeApplicationStore = new D1EnvelopeApplicationStore(
				instrumented.database
			);
			const detail = await store.readDetail(ENVELOPE_ID);
			expect(hooked).toBe(false);
			expect(detail?.fields).toHaveLength(4);
			expect(detail?.readyAuditEventId).toBe(READY_AUDIT_ID);
			expect(instrumented.batchCalls).toBe(1);
			expect(instrumented.firstCalls).toBe(0);
		} finally {
			sqlite.close();
		}
	});
});
