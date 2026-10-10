import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListObjectsResult, ObjectStore } from '$lib/ports/object-store';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import { OrphanCollector, PostgresOrphanReferenceStore } from './orphan-collector';

/**
 * Exercises `PostgresOrphanReferenceStore` against a real PostgreSQL
 * instance, not a mocked SQL client. Runs in its own schema so it never
 * touches `public` or any other suite's tables; skipped entirely when
 * `POSTGRES_TEST_URL` is unset, matching every other PostgreSQL
 * `*.integration.spec.ts` in this codebase.
 */

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;

const T0: string = '2026-09-11T00:00:00.000Z';
const NOW: Date = new Date('2026-09-22T12:00:00.000Z');
const OLD_UPLOAD: string = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();

postgresDescribe('PostgresOrphanReferenceStore signature asset references', () => {
	const schema: string = `signkit_opsfix_orphan_${newUuidV7().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;

	beforeEach(async () => {
		sql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		const paths: string[] = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		for (const path of paths) {
			await sql.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
		}
	});

	afterEach(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await sql.end({ timeout: 5 });
	});

	async function seedEnvelopeAndRecipient(
		client: ReturnType<typeof postgres>,
		envelopeId: string,
		recipientId: string,
		routingOrder: number
	): Promise<void> {
		await client`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', ${T0}::timestamptz, ${T0}::timestamptz)
			ON CONFLICT (user_id) DO NOTHING
		`;
		await client`
			INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, created_at, updated_at
			) VALUES (
				${envelopeId}, 'user-1', 'Agreement', 'completed', 1, ${T0}::timestamptz, ${T0}::timestamptz
			)
			ON CONFLICT (id) DO NOTHING
		`;
		await client`
			INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
			) VALUES (
				${recipientId}, ${envelopeId}, ${recipientId + '@example.test'}, 'Signer', 'signer', 'en',
				${routingOrder}, 'completed', ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
	}

	async function seedFieldValue(
		client: ReturnType<typeof postgres>,
		input: {
			fieldId: string;
			envelopeId: string;
			recipientId: string;
			fieldType: 'signature' | 'initials';
			sha256: string;
		}
	): Promise<void> {
		await client`
			INSERT INTO envelope_field (
				id, envelope_id, recipient_id, document_path, field_type, label, required, position, created_at, updated_at
			) VALUES (
				${input.fieldId}, ${input.envelopeId}, ${input.recipientId}, 'documents/agreement.md',
				${input.fieldType}, ${input.fieldType === 'initials' ? 'Initials' : 'Signature'}, true, 0,
				${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO field_value (
				field_id, envelope_id, recipient_id, field_type, value_json, value_sha256, created_at
			) VALUES (
				${input.fieldId}, ${input.envelopeId}, ${input.recipientId}, ${input.fieldType},
				${JSON.stringify(`sig:sha256:${input.sha256}`)}, ${'c'.repeat(64)}, ${T0}::timestamptz
			)
		`;
	}

	it('classifies a drawn-initials sig:sha256 asset referenced by field_value as live', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const recipientId: string = newUuidV7();
		const otherRecipientId: string = newUuidV7();
		const sha256: string = 'ab'.repeat(32);
		const orphanSha256: string = 'cd'.repeat(32);
		const assetKey = `signature-assets/v1/envelopes/${envelopeId}/recipients/${recipientId}/sha256/${sha256}.png`;
		const orphanAssetKey = `signature-assets/v1/envelopes/${envelopeId}/recipients/${otherRecipientId}/sha256/${orphanSha256}.png`;

		await seedEnvelopeAndRecipient(sql, envelopeId, recipientId, 1);
		await seedEnvelopeAndRecipient(sql, envelopeId, otherRecipientId, 2);
		await seedFieldValue(sql, {
			fieldId: newUuidV7(),
			envelopeId,
			recipientId,
			fieldType: 'initials',
			sha256
		});

		const store = new PostgresOrphanReferenceStore(sql);
		const referenced = await store.filterReferencedKeys([
			assetKey,
			orphanAssetKey,
			'drafts/orphan.git.gz'
		]);

		expect(referenced.has(assetKey)).toBe(true);
		expect(referenced.has(orphanAssetKey)).toBe(false);
		expect(referenced.has('drafts/orphan.git.gz')).toBe(false);
	});

	it('retains a drawn-initials sig:sha256 asset past the grace period while sweeping an unrelated recipient asset', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const envelopeId: string = newUuidV7();
		const initialsRecipientId: string = newUuidV7();
		const orphanRecipientId: string = newUuidV7();
		const initialsSha256: string = 'ab'.repeat(32);
		const orphanSha256: string = 'cd'.repeat(32);
		const initialsAssetKey = `signature-assets/v1/envelopes/${envelopeId}/recipients/${initialsRecipientId}/sha256/${initialsSha256}.png`;
		const orphanAssetKey = `signature-assets/v1/envelopes/${envelopeId}/recipients/${orphanRecipientId}/sha256/${orphanSha256}.png`;

		await seedEnvelopeAndRecipient(sql, envelopeId, initialsRecipientId, 1);
		await seedEnvelopeAndRecipient(sql, envelopeId, orphanRecipientId, 2);
		await seedFieldValue(sql, {
			fieldId: newUuidV7(),
			envelopeId,
			recipientId: initialsRecipientId,
			fieldType: 'initials',
			sha256: initialsSha256
		});

		const keys: string[] = [initialsAssetKey, orphanAssetKey];
		const deleteManyMock = vi.fn(async (deleted: readonly string[]): Promise<void> => {
			for (const key of deleted) {
				const index: number = keys.indexOf(key);
				if (index >= 0) keys.splice(index, 1);
			}
		});
		const objects: ObjectStore = {
			get: vi.fn(),
			head: vi.fn(),
			putImmutable: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(async (): Promise<ListObjectsResult> => ({
				objects: keys.map((key: string) => ({ key, size: 10, uploadedAt: OLD_UPLOAD })),
				truncated: false
			})),
			deleteMany: deleteManyMock
		};

		const report = await new OrphanCollector(
			objects,
			new PostgresOrphanReferenceStore(sql),
			() => NOW
		).sweep();

		expect(report.deletedKeys).toEqual([orphanAssetKey]);
		expect(deleteManyMock).toHaveBeenCalledWith([orphanAssetKey]);
		expect(keys).toEqual([initialsAssetKey]);
	});
});
