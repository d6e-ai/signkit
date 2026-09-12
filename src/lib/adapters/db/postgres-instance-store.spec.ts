import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	InstanceCallerContext
} from '$lib/ports/instance-store';
import { PostgresInstanceStore } from './postgres-instance-store';

const ACTOR_ID: string = 'user-owner-1';
const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const CREATED_AT: Date = new Date('2026-09-12T12:00:00.000Z');

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	beginCalls: number = 0;
	rollbacks: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result: ScriptedResult): ScriptedResult =>
			result instanceof Error ? result : [...result]
		);
	}

	client(): ReturnType<typeof postgres> {
		const client: ReturnType<typeof postgres> = this.#tag();
		Object.assign(client, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				try {
					return await callback(this.#tag());
				} catch (error: unknown) {
					this.rollbacks += 1;
					throw error;
				}
			}
		});
		return client;
	}

	texts(): readonly string[] {
		return this.queries.map((query: RecordedQuery): string => query.text);
	}

	#tag(): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			let text: string = '';
			const bound: unknown[] = [];
			strings.forEach((chunk: string, index: number): void => {
				text += chunk;
				if (index >= values.length) return;
				const value: unknown = values[index];
				text += '?';
				bound.push(value);
			});
			this.queries.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values: bound });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined) throw new Error(`Unexpected PostgreSQL query: ${text}`);
			if (result instanceof Error) throw result;
			return result;
		};
		return query as unknown as ReturnType<typeof postgres>;
	}
}

function store(scripted: ScriptedPostgres): PostgresInstanceStore {
	return new PostgresInstanceStore(scripted.client());
}

function command(overrides: Partial<BootstrapInstanceCommand> = {}): BootstrapInstanceCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: REQUEST_FINGERPRINT,
		createdAt: CREATED_AT.toISOString(),
		...overrides
	};
}

describe('PostgresInstanceStore', () => {
	describe('bootstrapInstance', () => {
		it('atomically claims the initial owner slot on an empty instance', async () => {
			const scripted = new ScriptedPostgres([
				[], // receipt check (none)
				[], // bootstrap table check (empty)
				[{ count: '0' }], // member table count check (0)
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // member insert RETURNING
				[{ ownerUserId: ACTOR_ID }], // bootstrap insert RETURNING
				[{ actorId: ACTOR_ID }] // receipt insert RETURNING
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'bootstrapped',
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				}
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(0);
			expect(scripted.texts()[3]).toContain('INSERT INTO instance_member');
			expect(scripted.texts()[4]).toContain('INSERT INTO instance_bootstrap');
			expect(scripted.texts()[5]).toContain('INSERT INTO instance_bootstrap_command');
		});

		it('replays an exact request safely under matching receipt', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				], // receipt found with matching hash
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				], // member row
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }] // bootstrap row
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				},
				replayed: true
			});
			expect(scripted.beginCalls).toBe(1);
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns idempotency_conflict when receipt request hash differs', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: OTHER_REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				] // receipt found with differing hash
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({ outcome: 'idempotency_conflict' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns already_bootstrapped without replay when instance is already claimed', async () => {
			const scripted = new ScriptedPostgres([
				[], // no receipt for this actor + key
				[{ singletonKey: 1, ownerUserId: 'other-user', createdAt: CREATED_AT }], // bootstrap exists
				[{ count: '1' }] // members exist
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns already_bootstrapped when instance_member has preexisting rows without bootstrap', async () => {
			const scripted = new ScriptedPostgres([
				[], // no receipt
				[], // no bootstrap row
				[{ count: '2' }] // member count > 0
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('returns integrity_error when replay receipt references non-owner member', async () => {
			const scripted = new ScriptedPostgres([
				[
					{
						requestHash: REQUEST_FINGERPRINT,
						ownerUserId: ACTOR_ID,
						createdAt: CREATED_AT
					}
				],
				[
					{
						userId: ACTOR_ID,
						role: 'member', // corrupted role
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				],
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }]
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({ outcome: 'integrity_error' });
			expect(scripted.rollbacks).toBe(1);
		});

		it('classifies concurrent insert conflict and does not throw', async () => {
			const scripted = new ScriptedPostgres([
				[], // receipt (none)
				[], // bootstrap (none)
				[{ count: '0' }], // member count (0)
				[], // member insert returned 0 rows due to race ON CONFLICT DO NOTHING
				// classification queries:
				[], // receipt query (none)
				[{ singletonKey: 1, ownerUserId: 'raced-owner', createdAt: CREATED_AT }], // bootstrap won by another
				[{ count: '1' }]
			]);

			const result: BootstrapInstanceStoreResult =
				await store(scripted).bootstrapInstance(command());

			expect(result).toEqual({
				outcome: 'already_bootstrapped',
				replayed: false
			});
			expect(scripted.rollbacks).toBe(1);
		});

		it('re-throws unexpected driver errors', async () => {
			const scripted = new ScriptedPostgres([new Error('PostgreSQL connection terminated')]);

			await expect(store(scripted).bootstrapInstance(command())).rejects.toThrow(
				'PostgreSQL connection terminated'
			);
			expect(scripted.rollbacks).toBe(1);
		});
	});

	describe('getInstanceCallerContext', () => {
		it('returns null member and bootstrapped false when clean', async () => {
			const scripted = new ScriptedPostgres([
				[], // no bootstrap row
				[] // no member row
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: null,
				bootstrapped: false
			});
		});

		it('returns member metadata and bootstrapped true when member exists', async () => {
			const scripted = new ScriptedPostgres([
				[{ singletonKey: 1, ownerUserId: ACTOR_ID, createdAt: CREATED_AT }],
				[
					{
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				]
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: {
					userId: ACTOR_ID,
					role: 'owner',
					status: 'active',
					createdAt: CREATED_AT.toISOString(),
					updatedAt: CREATED_AT.toISOString()
				},
				bootstrapped: true
			});
		});

		it('returns null member and bootstrapped true when caller is non-member on bootstrapped instance', async () => {
			const scripted = new ScriptedPostgres([
				[{ singletonKey: 1, ownerUserId: 'other-owner', createdAt: CREATED_AT }],
				[] // caller not found in instance_member
			]);

			const context: InstanceCallerContext =
				await store(scripted).getInstanceCallerContext(ACTOR_ID);

			expect(context).toEqual({
				member: null,
				bootstrapped: true
			});
		});
	});
});
