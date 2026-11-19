import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSigningReservation } from '$lib/application/pdf-seals/provider-signing-gate';
import { PostgresProviderSigningReplay } from './postgres-provider-signing-replay';

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;

type Sql = ReturnType<typeof postgres>;

const HASH_A: string = 'a'.repeat(64);
const HASH_B: string = 'b'.repeat(64);
let testAudience: string;

function request(overrides: Partial<ProviderSigningReservation> = {}): ProviderSigningReservation {
	return {
		issuer: 'issuer-1',
		audience: testAudience,
		envelopeId: 'envelope-1',
		operationId: 'operation-1',
		authorizationSha256: HASH_A,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides
	};
}

postgresDescribe('PostgreSQL provider signing replay ledger', () => {
	const schema: string = `signkit_replay_${randomUUID().replaceAll('-', '')}`;
	let admin: Sql | null = null;
	let sql: Sql | null = null;

	beforeAll(async () => {
		admin = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await admin.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = postgres(DATABASE_URL as string, {
			max: 8,
			onnotice: (): void => undefined,
			connection: { search_path: schema, application_name: schema }
		});
		await sql.unsafe(readFileSync('tools/pdf-seal-authority/postgres-schema.sql', 'utf8'));
	});

	beforeEach(() => {
		testAudience = randomUUID();
	});

	afterAll(async () => {
		if (sql !== null) await sql.end({ timeout: 5 });
		if (admin === null) return;
		await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await admin.end({ timeout: 5 });
	});

	function ledger(): PostgresProviderSigningReplay {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		return new PostgresProviderSigningReplay(sql);
	}

	it('reserves once and replays exactly across renewed authorization', async () => {
		expect(await ledger().reserve(request())).toBe('reserved');
		expect(await ledger().reserve(request())).toBe('existing');
		expect(
			await ledger().reserve(request({ expiresAt: new Date(Date.now() + 120_000).toISOString() }))
		).toBe('existing');
	});

	it('rejects expiry at the durable admission boundary without consuming the envelope', async () => {
		expect(await ledger().reserve(request({ expiresAt: '2020-01-01T00:00:00.000Z' }))).toBe(
			'conflict'
		);
		expect(await ledger().reserve(request())).toBe('reserved');
	});

	it('conflicts on a reused operation with a different envelope or hash', async () => {
		await ledger().reserve(request());
		expect(await ledger().reserve(request({ envelopeId: 'envelope-2' }))).toBe('conflict');
		expect(await ledger().reserve(request({ authorizationSha256: HASH_B }))).toBe('conflict');
	});

	it('allows only one key use per envelope', async () => {
		await ledger().reserve(request());
		expect(await ledger().reserve(request({ operationId: 'operation-2' }))).toBe('conflict');
	});

	it('scopes uniqueness to issuer and audience', async () => {
		await ledger().reserve(request());
		expect(await ledger().reserve(request({ issuer: 'issuer-2' }))).toBe('reserved');
		expect(await ledger().reserve(request({ audience: 'audience-2' }))).toBe('reserved');
	});

	it('is permanent across a new connection and immutable', async () => {
		await ledger().reserve(request());
		const restarted: Sql = postgres(DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined,
			connection: { search_path: schema }
		});
		try {
			expect(await new PostgresProviderSigningReplay(restarted).reserve(request())).toBe(
				'existing'
			);
		} finally {
			await restarted.end({ timeout: 5 });
		}
		await expect(sql!.unsafe('DELETE FROM provider_signing_replay')).rejects.toThrow(/immutable/);
		await expect(sql!.unsafe('TRUNCATE provider_signing_replay')).rejects.toThrow(/immutable/);
		await expect(
			sql!.unsafe(`UPDATE provider_signing_replay SET authorization_sha256 = '${HASH_B}'`)
		).rejects.toThrow(/immutable/);
	});

	it('grants exactly one reservation under concurrent identical requests', async () => {
		const results = await Promise.all(
			Array.from({ length: 12 }, () => ledger().reserve(request()))
		);
		expect(results.filter((r) => r === 'reserved')).toHaveLength(1);
		expect(results.filter((r) => r === 'existing')).toHaveLength(11);
	});

	it('grants one key use per envelope under concurrent distinct operations', async () => {
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) => ledger().reserve(request({ operationId: `op-${i}` })))
		);
		expect(results.filter((r) => r === 'reserved')).toHaveLength(1);
		expect(results.filter((r) => r === 'conflict')).toHaveLength(11);
	});
});
