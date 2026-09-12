import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	BootstrapInstanceCommand,
	BootstrapInstanceStoreResult,
	InstanceCallerContext
} from '$lib/ports/instance-store';
import { D1InstanceStore } from './d1-instance-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ACTOR_ID: string = 'user-owner-1';
const OTHER_ACTOR_ID: string = 'user-other-2';
const IDEMPOTENCY_KEY: string = 'bootstrap-idem-key-1';
const REQUEST_FINGERPRINT: string = 'a'.repeat(64);
const OTHER_REQUEST_FINGERPRINT: string = 'b'.repeat(64);
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';

function bootstrapCommand(
	overrides: Partial<BootstrapInstanceCommand> = {}
): BootstrapInstanceCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: IDEMPOTENCY_KEY,
		requestFingerprint: REQUEST_FINGERPRINT,
		createdAt: CREATED_AT,
		...overrides
	};
}

interface Fixture {
	sqlite: DatabaseSync;
	store: D1InstanceStore;
}

function createFixture(): Fixture {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const store = new D1InstanceStore(sqliteD1Database(sqlite));
	return { sqlite, store };
}

describe('D1InstanceStore', () => {
	describe('bootstrapInstance', () => {
		it('atomically claims the first active owner slot on an empty instance', async () => {
			const { store, sqlite } = createFixture();
			try {
				const result: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(result).toEqual({
					outcome: 'bootstrapped',
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					}
				});

				const member = sqlite
					.prepare('SELECT user_id, role, status FROM instance_member WHERE user_id = ?')
					.get(ACTOR_ID) as { user_id: string; role: string; status: string };
				expect(member).toEqual({
					user_id: ACTOR_ID,
					role: 'owner',
					status: 'active'
				});

				const bootstrap = sqlite
					.prepare('SELECT singleton_key, owner_user_id FROM instance_bootstrap')
					.get() as { singleton_key: number; owner_user_id: string };
				expect(bootstrap).toEqual({
					singleton_key: 1,
					owner_user_id: ACTOR_ID
				});

				const receipt = sqlite
					.prepare(
						'SELECT actor_type, actor_id, idempotency_key, request_hash, owner_user_id FROM instance_bootstrap_command'
					)
					.get() as {
					actor_type: string;
					actor_id: string;
					idempotency_key: string;
					request_hash: string;
					owner_user_id: string;
				};
				expect(receipt).toEqual({
					actor_type: 'user',
					actor_id: ACTOR_ID,
					idempotency_key: IDEMPOTENCY_KEY,
					request_hash: REQUEST_FINGERPRINT,
					owner_user_id: ACTOR_ID
				});
			} finally {
				sqlite.close();
			}
		});

		it('leaves exactly one owner and no orphan member under concurrent different-subject bootstrap', async () => {
			const { store, sqlite } = createFixture();
			try {
				const [first, second]: BootstrapInstanceStoreResult[] = await Promise.all([
					store.bootstrapInstance(bootstrapCommand({ actor: { type: 'user', id: ACTOR_ID } })),
					store.bootstrapInstance(
						bootstrapCommand({
							actor: { type: 'user', id: OTHER_ACTOR_ID },
							idempotencyKey: 'other-idem-key',
							requestFingerprint: OTHER_REQUEST_FINGERPRINT
						})
					)
				]);

				const outcomes: string[] = [first.outcome, second.outcome].sort();
				expect(outcomes).toEqual(['already_bootstrapped', 'bootstrapped']);

				const members = sqlite.prepare('SELECT user_id, role FROM instance_member').all() as {
					user_id: string;
					role: string;
				}[];
				expect(members).toHaveLength(1);
				expect(members[0].role).toBe('owner');

				const bootstrapRows = sqlite
					.prepare('SELECT owner_user_id FROM instance_bootstrap')
					.all() as { owner_user_id: string }[];
				expect(bootstrapRows).toHaveLength(1);
				expect(bootstrapRows[0].owner_user_id).toBe(members[0].user_id);
			} finally {
				sqlite.close();
			}
		});

		it('safely replays an exact request under the original idempotency key', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const replay: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(replay).toEqual({
					outcome: 'already_bootstrapped',
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					replayed: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('rejects a reused idempotency key with a conflicting request fingerprint', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const conflict: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ requestFingerprint: OTHER_REQUEST_FINGERPRINT })
				);
				expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
			} finally {
				sqlite.close();
			}
		});

		it('classifies cross-subject attempt as already_bootstrapped without replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const otherAttempt: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ actor: { type: 'user', id: OTHER_ACTOR_ID } })
				);
				expect(otherAttempt).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('classifies same-subject fresh idempotency key as already_bootstrapped without replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const freshKeyAttempt: BootstrapInstanceStoreResult = await store.bootstrapInstance(
					bootstrapCommand({ idempotencyKey: 'different-idem-key' })
				);
				expect(freshKeyAttempt).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('refuses bootstrap when instance_member has preexisting members', async () => {
			const { store, sqlite } = createFixture();
			try {
				sqlite.exec(`
					INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
					VALUES ('preexisting-user', 'member', 'active', '${CREATED_AT}', '${CREATED_AT}')
				`);

				const result: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(result).toEqual({
					outcome: 'already_bootstrapped',
					replayed: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('detects receipt drift or missing owner as integrity_error on replay', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				// Corrupt owner member state
				sqlite.exec(
					`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${ACTOR_ID}'`
				);

				const replay: BootstrapInstanceStoreResult =
					await store.bootstrapInstance(bootstrapCommand());
				expect(replay).toEqual({ outcome: 'integrity_error' });
			} finally {
				sqlite.close();
			}
		});
	});

	describe('getInstanceCallerContext', () => {
		it('returns null member and bootstrapped false when instance is clean', async () => {
			const { store, sqlite } = createFixture();
			try {
				const context: InstanceCallerContext = await store.getInstanceCallerContext(ACTOR_ID);
				expect(context).toEqual({
					member: null,
					bootstrapped: false
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns owner metadata and bootstrapped true when caller is owner', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const context: InstanceCallerContext = await store.getInstanceCallerContext(ACTOR_ID);
				expect(context).toEqual({
					member: {
						userId: ACTOR_ID,
						role: 'owner',
						status: 'active',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns null member and bootstrapped true when caller is non-member', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());

				const context: InstanceCallerContext = await store.getInstanceCallerContext(OTHER_ACTOR_ID);
				expect(context).toEqual({
					member: null,
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});

		it('returns suspended member metadata and bootstrapped true when caller is suspended', async () => {
			const { store, sqlite } = createFixture();
			try {
				await store.bootstrapInstance(bootstrapCommand());
				sqlite.exec(`
					INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
					VALUES ('suspended-user', 'member', 'suspended', '${CREATED_AT}', '${CREATED_AT}')
				`);

				const context: InstanceCallerContext =
					await store.getInstanceCallerContext('suspended-user');
				expect(context).toEqual({
					member: {
						userId: 'suspended-user',
						role: 'member',
						status: 'suspended',
						createdAt: CREATED_AT,
						updatedAt: CREATED_AT
					},
					bootstrapped: true
				});
			} finally {
				sqlite.close();
			}
		});
	});
});
