import { describe, expect, it } from 'vitest';
import {
	DEFAULT_INSTANCE_INVITATION_LIST_LIMIT,
	INSTANCE_INVITATION_DEFAULT_EXPIRY_MS,
	MAX_INSTANCE_INVITATION_LIST_LIMIT,
	type AcceptInstanceInvitationCommand,
	type AcceptInstanceInvitationStoreResult,
	type BootstrapInstanceStoreResult,
	type CreateInstanceInvitationCommand,
	type CreateInstanceInvitationStoreResult,
	type InstanceActor,
	type InstanceCallerContext,
	type InstanceInvitationListPage,
	type InstanceInvitationListQuery,
	type InstanceInvitationMetadata,
	type InstanceMemberMetadata,
	type InstanceStore,
	type ListInstanceInvitationsStoreResult,
	type RevokeInstanceInvitationCommand,
	type RevokeInstanceInvitationStoreResult
} from '$lib/ports/instance-store';
import {
	canonicalJson,
	InstanceInvitationApplication,
	InstanceInvitationCollisionExhaustedError,
	InstanceInvitationService,
	InvalidInstanceInvitationRequestError,
	sha256Hex,
	type AcceptInstanceInvitationInput,
	type AcceptInstanceInvitationResult,
	type CreateInstanceInvitationInput,
	type CreateInstanceInvitationResult,
	type InstanceInvitationActor,
	type RevokeInstanceInvitationResult
} from './instance-invitation-service';
import {
	computeInstanceInvitationEmailBinding,
	hashInstanceInvitationToken,
	type IssuedInstanceInvitationToken
} from '$lib/security/instance-invitation';

const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const EXPECTED_EXPIRY: string = new Date(
	NOW.valueOf() + INSTANCE_INVITATION_DEFAULT_EXPIRY_MS
).toISOString();
const ACTOR: InstanceInvitationActor = { id: 'inviter-user-1' };
const ACCEPTOR_ACTOR: InstanceInvitationActor = { id: 'acceptor-user-2' };
const VALID_UUID_1: string = '01900000-0000-7000-8000-000000000001';
const VALID_UUID_2: string = '01900000-0000-7000-8000-000000000002';
const VALID_UUID_3: string = '01900000-0000-7000-8000-000000000003';
const VALID_UUID_4: string = '01900000-0000-7000-8000-000000000004';

class FakeInstanceStore implements InstanceStore {
	readonly createCommands: CreateInstanceInvitationCommand[] = [];
	readonly listCalls: { actor: InstanceActor; query: InstanceInvitationListQuery }[] = [];
	readonly acceptCommands: AcceptInstanceInvitationCommand[] = [];
	readonly revokeCommands: RevokeInstanceInvitationCommand[] = [];

	readonly #createResults: CreateInstanceInvitationStoreResult[];
	readonly #listResults: ListInstanceInvitationsStoreResult[];
	readonly #acceptResults: AcceptInstanceInvitationStoreResult[];
	readonly #revokeResults: RevokeInstanceInvitationStoreResult[];

	constructor(
		createResults: readonly CreateInstanceInvitationStoreResult[] = [],
		listResults: readonly ListInstanceInvitationsStoreResult[] = [],
		acceptResults: readonly AcceptInstanceInvitationStoreResult[] = [],
		revokeResults: readonly RevokeInstanceInvitationStoreResult[] = []
	) {
		this.#createResults = [...createResults];
		this.#listResults = [...listResults];
		this.#acceptResults = [...acceptResults];
		this.#revokeResults = [...revokeResults];
	}

	async createInstanceInvitation(
		command: CreateInstanceInvitationCommand
	): Promise<CreateInstanceInvitationStoreResult> {
		this.createCommands.push(command);
		const scripted: CreateInstanceInvitationStoreResult | undefined = this.#createResults.shift();
		return scripted ?? { outcome: 'created', invitation: createInvitationMetadata(command) };
	}

	async listInstanceInvitations(
		actor: InstanceActor,
		query: InstanceInvitationListQuery
	): Promise<ListInstanceInvitationsStoreResult> {
		this.listCalls.push({ actor, query });
		const scripted: ListInstanceInvitationsStoreResult | undefined = this.#listResults.shift();
		return (
			scripted ?? {
				outcome: 'listed',
				page: { items: [], nextCursor: null }
			}
		);
	}

	async acceptInstanceInvitation(
		command: AcceptInstanceInvitationCommand
	): Promise<AcceptInstanceInvitationStoreResult> {
		this.acceptCommands.push(command);
		const scripted: AcceptInstanceInvitationStoreResult | undefined = this.#acceptResults.shift();
		return (
			scripted ?? {
				outcome: 'accepted',
				invitation: acceptInvitationMetadata(command),
				member: memberMetadata(command.actor.id, 'admin')
			}
		);
	}

	async revokeInstanceInvitation(
		command: RevokeInstanceInvitationCommand
	): Promise<RevokeInstanceInvitationStoreResult> {
		this.revokeCommands.push(command);
		const scripted: RevokeInstanceInvitationStoreResult | undefined = this.#revokeResults.shift();
		return scripted ?? { outcome: 'revoked', invitation: revokeInvitationMetadata(command) };
	}

	async bootstrapInstance(): Promise<BootstrapInstanceStoreResult> {
		return { outcome: 'integrity_error' };
	}

	async getInstanceCallerContext(): Promise<InstanceCallerContext> {
		return { member: null, bootstrapped: false };
	}
}

function createInvitationMetadata(
	command: CreateInstanceInvitationCommand,
	overrides: Partial<InstanceInvitationMetadata> = {}
): InstanceInvitationMetadata {
	return {
		id: command.invitationId,
		role: command.role,
		status: 'pending',
		invitedByUserId: command.actor.id,
		createdAt: command.createdAt,
		expiresAt: command.expiresAt,
		acceptedAt: null,
		acceptedByUserId: null,
		revokedAt: null,
		revokedByUserId: null,
		...overrides
	};
}

function acceptInvitationMetadata(
	command: AcceptInstanceInvitationCommand,
	overrides: Partial<InstanceInvitationMetadata> = {}
): InstanceInvitationMetadata {
	return {
		id: VALID_UUID_1,
		role: 'admin',
		status: 'accepted',
		invitedByUserId: 'inviter-user-1',
		createdAt: '2026-09-10T00:00:00.000Z',
		expiresAt: '2026-09-17T00:00:00.000Z',
		acceptedAt: command.acceptedAt,
		acceptedByUserId: command.actor.id,
		revokedAt: null,
		revokedByUserId: null,
		...overrides
	};
}

function revokeInvitationMetadata(
	command: RevokeInstanceInvitationCommand,
	overrides: Partial<InstanceInvitationMetadata> = {}
): InstanceInvitationMetadata {
	return {
		id: command.invitationId,
		role: 'admin',
		status: 'revoked',
		invitedByUserId: 'inviter-user-1',
		createdAt: '2026-09-10T00:00:00.000Z',
		expiresAt: '2026-09-17T00:00:00.000Z',
		acceptedAt: null,
		acceptedByUserId: null,
		revokedAt: command.revokedAt,
		revokedByUserId: command.actor.id,
		...overrides
	};
}

function memberMetadata(
	userId: string,
	role: 'owner' | 'admin' | 'member'
): InstanceMemberMetadata {
	return {
		userId,
		role,
		status: 'active',
		createdAt: NOW.toISOString(),
		updatedAt: NOW.toISOString()
	};
}

function createTestApp(
	store: FakeInstanceStore,
	options: {
		now?: Date | (() => Date);
		uuids?: readonly string[];
		tokens?: readonly IssuedInstanceInvitationToken[];
	} = {}
): InstanceInvitationApplication {
	const fixedNow: Date = typeof options.now === 'function' ? NOW : (options.now ?? NOW);
	const clock: () => Date = typeof options.now === 'function' ? options.now : (): Date => fixedNow;
	const uuidPool: string[] = [
		...(options.uuids ?? [VALID_UUID_1, VALID_UUID_2, VALID_UUID_3, VALID_UUID_4])
	];
	const tokenPool: IssuedInstanceInvitationToken[] = [...(options.tokens ?? [])];

	const newId = (): string => uuidPool.shift() ?? VALID_UUID_1;
	const issueToken = async (): Promise<IssuedInstanceInvitationToken> => {
		if (tokenPool.length > 0) return tokenPool.shift()!;
		// Mint a deterministic ski1_ test token
		const token = `ski1_${'a'.repeat(43)}`;
		const tokenHash = await hashInstanceInvitationToken(token);
		return { token, tokenHash };
	};

	return new InstanceInvitationApplication({
		store,
		now: clock,
		newId,
		issueToken
	});
}

describe('InstanceInvitationApplication', () => {
	describe('create', () => {
		it('creates a fresh invitation with fixed 7-day expiry, canonical {role} fingerprint, and one-time token', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const input: CreateInstanceInvitationInput = {
				idempotencyKey: 'idemp-create-1',
				email: '  Alice@Example.COM  ',
				role: 'admin'
			};

			const result: CreateInstanceInvitationResult = await app.create(ACTOR, input);

			expect(result.outcome).toBe('created');
			if (result.outcome !== 'created') return;

			expect(result.replayed).toBe(false);
			expect(result.token).toMatch(/^ski1_[A-Za-z0-9_-]{43}$/);
			expect(result.invitation.id).toBe(VALID_UUID_1);
			expect(result.invitation.role).toBe('admin');
			expect(result.invitation.status).toBe('pending');

			expect(store.createCommands).toHaveLength(1);
			const command = store.createCommands[0];
			expect(command.actor).toEqual({ type: 'user', id: 'inviter-user-1' });
			expect(command.idempotencyKey).toBe('idemp-create-1');
			expect(command.invitationId).toBe(VALID_UUID_1);
			expect(command.role).toBe('admin');
			expect(command.createdAt).toBe(NOW.toISOString());
			expect(command.expiresAt).toBe(EXPECTED_EXPIRY);
			expect(command.tokenHash).toBe(await hashInstanceInvitationToken(result.token));
			expect(command.emailBinding).toBe(
				await computeInstanceInvitationEmailBinding(result.token, 'alice@example.com')
			);

			// Stable sha256 fingerprint covers canonical { role } only:
			const expectedFingerprint = await sha256Hex(canonicalJson({ role: 'admin' }));
			expect(command.requestFingerprint).toBe(expectedFingerprint);
		});

		it('ensures token one-time response: returned on fresh creation, absent on replay', async () => {
			const invitation: InstanceInvitationMetadata = {
				id: VALID_UUID_1,
				role: 'member',
				status: 'pending',
				invitedByUserId: 'inviter-user-1',
				createdAt: '2026-09-12T00:00:00.000Z',
				expiresAt: '2026-09-19T00:00:00.000Z',
				acceptedAt: null,
				acceptedByUserId: null,
				revokedAt: null,
				revokedByUserId: null
			};
			const store = new FakeInstanceStore([{ outcome: 'replayed', invitation }]);
			const app = createTestApp(store);

			const result = await app.create(ACTOR, {
				idempotencyKey: 'idemp-replay-1',
				email: 'bob@example.com',
				role: 'member'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.replayed).toBe(true);
				expect(result.invitation).toEqual(invitation);
				expect('token' in result).toBe(false);
			}
		});

		it('guarantees email is absent from fingerprint and outputs (zero PII)', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const email1 = 'alice@example.com';
			const email2 = 'completely-different-address@domain.org';

			await app.create(ACTOR, {
				idempotencyKey: 'key-1',
				email: email1,
				role: 'owner'
			});

			await app.create(ACTOR, {
				idempotencyKey: 'key-2',
				email: email2,
				role: 'owner'
			});

			expect(store.createCommands).toHaveLength(2);
			const fp1 = store.createCommands[0].requestFingerprint;
			const fp2 = store.createCommands[1].requestFingerprint;

			// Fingerprints must be identical because role is the same
			expect(fp1).toBe(fp2);
			expect(fp1).toBe(await sha256Hex(canonicalJson({ role: 'owner' })));

			// Neither the plain emails nor any substring appears in the fingerprints
			expect(fp1).not.toContain(email1);
			expect(fp1).not.toContain(email2);

			// Result output contains zero email or PII
			const res = await app.create(ACTOR, {
				idempotencyKey: 'key-3',
				email: 'charlie@example.com',
				role: 'admin'
			});
			const serializedResult = JSON.stringify(res);
			expect(serializedResult).not.toContain('charlie@example.com');
			expect(serializedResult).not.toContain('email');
		});

		it('demonstrates the fresh key caveat: fresh key mints new credential, replay returns no secret', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			// 1. First call with key-1: mints a fresh token and invitation
			const first = await app.create(ACTOR, {
				idempotencyKey: 'key-1',
				email: 'user@example.com',
				role: 'member'
			});
			expect(first.outcome).toBe('created');
			if (first.outcome !== 'created') return;
			const firstToken = first.token;
			const firstId = first.invitation.id;
			expect(firstToken).toMatch(/^ski1_/);

			// 2. Replay with key-1: returns replayed: true, NO token
			const replayStore = new FakeInstanceStore([
				{ outcome: 'replayed', invitation: first.invitation }
			]);
			const replayApp = createTestApp(replayStore);
			const replay = await replayApp.create(ACTOR, {
				idempotencyKey: 'key-1',
				email: 'user@example.com',
				role: 'member'
			});
			expect(replay.outcome).toBe('replayed');
			if (replay.outcome === 'replayed') {
				expect(replay.replayed).toBe(true);
				expect((replay as Record<string, unknown>).token).toBeUndefined();
			}

			// 3. Fresh idempotency key key-2: mints completely fresh invitation and token
			const freshApp = createTestApp(store, { uuids: [VALID_UUID_2] });
			const fresh = await freshApp.create(ACTOR, {
				idempotencyKey: 'key-2',
				email: 'user@example.com',
				role: 'member'
			});
			expect(fresh.outcome).toBe('created');
			if (fresh.outcome === 'created') {
				expect(fresh.invitation.id).toBe(VALID_UUID_2);
				expect(fresh.invitation.id).not.toBe(firstId);
			}
		});

		it('retries collision up to 3 times on credential_collision and succeeds', async () => {
			const store = new FakeInstanceStore([
				{ outcome: 'credential_collision' },
				{ outcome: 'credential_collision' },
				{
					outcome: 'created',
					invitation: {
						id: VALID_UUID_3,
						role: 'member',
						status: 'pending',
						invitedByUserId: 'inviter-user-1',
						createdAt: NOW.toISOString(),
						expiresAt: EXPECTED_EXPIRY,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				}
			]);
			const app = createTestApp(store, {
				uuids: [VALID_UUID_1, VALID_UUID_2, VALID_UUID_3]
			});

			const result = await app.create(ACTOR, {
				idempotencyKey: 'retry-key',
				email: 'retry@example.com',
				role: 'member'
			});

			expect(result.outcome).toBe('created');
			expect(store.createCommands).toHaveLength(3);
			expect(store.createCommands[0].invitationId).toBe(VALID_UUID_1);
			expect(store.createCommands[1].invitationId).toBe(VALID_UUID_2);
			expect(store.createCommands[2].invitationId).toBe(VALID_UUID_3);
		});

		it('exhausts collision retries and throws after 3 consecutive credential_collisions', async () => {
			const store = new FakeInstanceStore([
				{ outcome: 'credential_collision' },
				{ outcome: 'credential_collision' },
				{ outcome: 'credential_collision' }
			]);
			const app = createTestApp(store);

			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'exhaust-key',
					email: 'exhaust@example.com',
					role: 'member'
				})
			).rejects.toThrow(InstanceInvitationCollisionExhaustedError);

			expect(store.createCommands).toHaveLength(3);
		});

		it('does NOT retry non-collision store outcomes', async () => {
			const outcomes: CreateInstanceInvitationStoreResult[] = [
				{ outcome: 'forbidden' },
				{ outcome: 'role_not_permitted' },
				{ outcome: 'limit' },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'member_suspended' },
				{ outcome: 'integrity_error' }
			];

			for (const storeResult of outcomes) {
				const store = new FakeInstanceStore([storeResult]);
				const app = createTestApp(store);

				const result = await app.create(ACTOR, {
					idempotencyKey: 'key',
					email: 'user@example.com',
					role: 'member'
				});

				expect(result.outcome).toBe(storeResult.outcome);
				expect(store.createCommands).toHaveLength(1);
			}
		});

		it('validates and rejects invalid inputs with descriptive error', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			// Invalid email
			await expect(
				app.create(ACTOR, { idempotencyKey: 'key-1', email: 'invalid-email', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(ACTOR, { idempotencyKey: 'key-1', email: '', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid role
			await expect(
				app.create(ACTOR, { idempotencyKey: 'key-1', email: 'a@b.co', role: 'superadmin' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'key-1',
					email: 'a@b.co',
					role: null as unknown as string
				})
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid idempotency key
			await expect(
				app.create(ACTOR, { idempotencyKey: '', email: 'a@b.co', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(ACTOR, { idempotencyKey: 'with space', email: 'a@b.co', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(ACTOR, { idempotencyKey: 'x'.repeat(201), email: 'a@b.co', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid actor
			await expect(
				app.create({ id: '' }, { idempotencyKey: 'key-1', email: 'a@b.co', role: 'member' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(
					{ id: 'x'.repeat(201) },
					{ idempotencyKey: 'key-1', email: 'a@b.co', role: 'member' }
				)
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.create(
					{ id: 'valid-id', type: 'invalid' as unknown as 'user' },
					{ idempotencyKey: 'key-1', email: 'a@b.co', role: 'member' }
				)
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid expiry
			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'key-1',
					email: 'a@b.co',
					role: 'member',
					expiresAt: null
				})
			).rejects.toThrow('Instance invitations must expire');

			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'key-1',
					email: 'a@b.co',
					role: 'member',
					expiresAt: 'not-a-date'
				})
			).rejects.toThrow('Invalid instance invitation expiry');

			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'key-1',
					email: 'a@b.co',
					role: 'member',
					expiresAt: '2026-09-12T11:00:00.000Z'
				})
			).rejects.toThrow('Instance invitation expiry must be in the future');

			await expect(
				app.create(ACTOR, {
					idempotencyKey: 'key-1',
					email: 'a@b.co',
					role: 'member',
					expiresAt: '2026-09-19T12:00:01.000Z'
				})
			).rejects.toThrow('Instance invitation expiry must be at most 7 days');

			// No commands reached the store
			expect(store.createCommands).toHaveLength(0);
		});

		it('preserves store replay timestamps without overwriting them with clock time', async () => {
			const originalCreatedAt = '2026-09-01T08:00:00.000Z';
			const originalExpiresAt = '2026-09-08T08:00:00.000Z';
			const replayedInvitation: InstanceInvitationMetadata = {
				id: VALID_UUID_1,
				role: 'admin',
				status: 'pending',
				invitedByUserId: 'inviter-user-1',
				createdAt: originalCreatedAt,
				expiresAt: originalExpiresAt,
				acceptedAt: null,
				acceptedByUserId: null,
				revokedAt: null,
				revokedByUserId: null
			};
			const store = new FakeInstanceStore([
				{ outcome: 'replayed', invitation: replayedInvitation }
			]);
			const app = createTestApp(store);

			const result = await app.create(ACTOR, {
				idempotencyKey: 'replay-key',
				email: 'alice@example.com',
				role: 'admin'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.invitation.createdAt).toBe(originalCreatedAt);
				expect(result.invitation.expiresAt).toBe(originalExpiresAt);
				expect(result.invitation.createdAt).not.toBe(NOW.toISOString());
			}
		});
	});

	describe('list', () => {
		it('validates, clamps limits to [1..100] and passes cursor to store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			// Default limit (25) and null cursor
			await app.list(ACTOR);
			expect(store.listCalls).toHaveLength(1);
			expect(store.listCalls[0].query).toEqual({
				cursor: null,
				limit: DEFAULT_INSTANCE_INVITATION_LIST_LIMIT
			});

			// Clamps limit > 100 to MAX (100)
			await app.list(ACTOR, { cursor: 'cursor-1', limit: 200 });
			expect(store.listCalls[1].query).toEqual({
				cursor: 'cursor-1',
				limit: MAX_INSTANCE_INVITATION_LIST_LIMIT
			});

			// Clamps limit < 1 to 1
			await app.list(ACTOR, { limit: 0 });
			expect(store.listCalls[2].query.limit).toBe(1);

			await app.list(ACTOR, { limit: -5 });
			expect(store.listCalls[3].query.limit).toBe(1);

			await app.list(ACTOR, { limit: Number.NaN });
			expect(store.listCalls[4].query.limit).toBe(1);

			await app.list(ACTOR, { limit: 50 });
			expect(store.listCalls[5].query.limit).toBe(50);
		});

		it('forwards store results for list', async () => {
			const page: InstanceInvitationListPage = {
				items: [
					{
						id: VALID_UUID_1,
						role: 'admin',
						status: 'pending',
						invitedByUserId: 'inviter-user-1',
						createdAt: NOW.toISOString(),
						expiresAt: EXPECTED_EXPIRY,
						acceptedAt: null,
						acceptedByUserId: null,
						revokedAt: null,
						revokedByUserId: null
					}
				],
				nextCursor: 'next-cur'
			};
			const store = new FakeInstanceStore([], [{ outcome: 'listed', page }]);
			const app = createTestApp(store);

			const result = await app.list(ACTOR);
			expect(result).toEqual({ outcome: 'listed', page });
		});

		it('forwards forbidden and member_suspended on list', async () => {
			const store = new FakeInstanceStore(
				[],
				[{ outcome: 'forbidden' }, { outcome: 'member_suspended' }]
			);
			const app = createTestApp(store);

			expect(await app.list(ACTOR)).toEqual({ outcome: 'forbidden' });
			expect(await app.list(ACTOR)).toEqual({ outcome: 'member_suspended' });
		});
	});

	describe('accept', () => {
		const validToken = `ski1_${'b'.repeat(43)}`;

		it('validates token, normalizes email, hashes token/binding, fingerprints canonical tokenHash, calls store with subject', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const input: AcceptInstanceInvitationInput = {
				idempotencyKey: 'accept-idemp-1',
				token: validToken,
				email: '  Signer@Example.COM  '
			};

			const result: AcceptInstanceInvitationResult = await app.accept(ACCEPTOR_ACTOR, input);

			expect(result.outcome).toBe('accepted');
			if (result.outcome !== 'accepted') return;
			expect(result.replayed).toBe(false);

			expect(store.acceptCommands).toHaveLength(1);
			const command = store.acceptCommands[0];
			expect(command.actor).toEqual({ type: 'user', id: 'acceptor-user-2' });
			expect(command.idempotencyKey).toBe('accept-idemp-1');
			expect(command.acceptedAt).toBe(NOW.toISOString());

			const expectedTokenHash = await hashInstanceInvitationToken(validToken);
			expect(command.tokenHash).toBe(expectedTokenHash);
			expect(command.emailBinding).toBe(
				await computeInstanceInvitationEmailBinding(validToken, 'signer@example.com')
			);

			// Fingerprints canonical { tokenHash }
			const expectedFingerprint = await sha256Hex(canonicalJson({ tokenHash: expectedTokenHash }));
			expect(command.requestFingerprint).toBe(expectedFingerprint);
		});

		it('marks replayed: true on idempotent replay of accept', async () => {
			const invitation: InstanceInvitationMetadata = {
				id: VALID_UUID_1,
				role: 'admin',
				status: 'accepted',
				invitedByUserId: 'inviter-user-1',
				createdAt: '2026-09-01T00:00:00.000Z',
				expiresAt: '2026-09-08T00:00:00.000Z',
				acceptedAt: '2026-09-02T10:00:00.000Z',
				acceptedByUserId: 'acceptor-user-2',
				revokedAt: null,
				revokedByUserId: null
			};
			const member = memberMetadata('acceptor-user-2', 'admin');
			const store = new FakeInstanceStore([], [], [{ outcome: 'replayed', invitation, member }]);
			const app = createTestApp(store);

			const result = await app.accept(ACCEPTOR_ACTOR, {
				idempotencyKey: 'accept-replay-1',
				token: validToken,
				email: 'signer@example.com'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.replayed).toBe(true);
				expect(result.invitation.acceptedAt).toBe('2026-09-02T10:00:00.000Z');
				expect(result.member).toEqual(member);
			}
		});

		it('demonstrates wrong binding construction: binding differs if email assertion is mismatched', async () => {
			const token = validToken;
			const correctEmail = 'signer@example.com';
			const wrongEmail = 'wrong-signer@example.com';

			const correctBinding = await computeInstanceInvitationEmailBinding(token, correctEmail);
			const wrongBinding = await computeInstanceInvitationEmailBinding(token, wrongEmail);

			expect(correctBinding).not.toBe(wrongBinding);

			// The store returns invitation_invalid when binding does not match
			const store = new FakeInstanceStore([], [], [{ outcome: 'invitation_invalid' }]);
			const app = createTestApp(store);

			const result = await app.accept(ACCEPTOR_ACTOR, {
				idempotencyKey: 'accept-wrong-binding',
				token,
				email: wrongEmail
			});

			expect(result.outcome).toBe('invitation_invalid');
			expect(store.acceptCommands[0].emailBinding).toBe(wrongBinding);
		});

		it('validates invalid accept inputs', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			// Invalid token prefix or length
			await expect(
				app.accept(ACCEPTOR_ACTOR, {
					idempotencyKey: 'key-1',
					token: 'invalid-token',
					email: 'a@b.co'
				})
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			await expect(
				app.accept(ACCEPTOR_ACTOR, {
					idempotencyKey: 'key-1',
					token: `skr1_${'a'.repeat(43)}`,
					email: 'a@b.co'
				})
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid email
			await expect(
				app.accept(ACCEPTOR_ACTOR, {
					idempotencyKey: 'key-1',
					token: validToken,
					email: 'not-an-email'
				})
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid actor
			await expect(
				app.accept({ id: '' }, { idempotencyKey: 'key-1', token: validToken, email: 'a@b.co' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Invalid idempotency key
			await expect(
				app.accept(ACCEPTOR_ACTOR, { idempotencyKey: '', token: validToken, email: 'a@b.co' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);
		});

		it('forwards other accept store outcomes (invitation_invalid, idempotency_conflict, member_suspended, integrity_error)', async () => {
			const outcomes: AcceptInstanceInvitationStoreResult[] = [
				{ outcome: 'invitation_invalid' },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'member_suspended' },
				{ outcome: 'integrity_error' }
			];

			for (const storeResult of outcomes) {
				const store = new FakeInstanceStore([], [], [storeResult]);
				const app = createTestApp(store);

				const result = await app.accept(ACCEPTOR_ACTOR, {
					idempotencyKey: 'key',
					token: validToken,
					email: 'signer@example.com'
				});

				expect(result.outcome).toBe(storeResult.outcome);
			}
		});
	});

	describe('revoke', () => {
		it('validates UUIDv7 target, fingerprints canonical target ID, calls store', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const result: RevokeInstanceInvitationResult = await app.revoke(ACTOR, VALID_UUID_1, {
				idempotencyKey: 'revoke-idemp-1'
			});

			expect(result.outcome).toBe('revoked');
			if (result.outcome !== 'revoked') return;
			expect(result.replayed).toBe(false);

			expect(store.revokeCommands).toHaveLength(1);
			const command = store.revokeCommands[0];
			expect(command.actor).toEqual({ type: 'user', id: 'inviter-user-1' });
			expect(command.idempotencyKey).toBe('revoke-idemp-1');
			expect(command.invitationId).toBe(VALID_UUID_1);
			expect(command.revokedAt).toBe(NOW.toISOString());

			// Fingerprint is sha256 of canonical { invitationId }
			const expectedFingerprint = await sha256Hex(canonicalJson({ invitationId: VALID_UUID_1 }));
			expect(command.requestFingerprint).toBe(expectedFingerprint);
		});

		it('supports revoke with single options object containing invitationId', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			const result = await app.revoke(ACTOR, {
				invitationId: VALID_UUID_1,
				idempotencyKey: 'revoke-idemp-2'
			});

			expect(result.outcome).toBe('revoked');
			expect(store.revokeCommands[0].invitationId).toBe(VALID_UUID_1);
			expect(store.revokeCommands[0].idempotencyKey).toBe('revoke-idemp-2');
		});

		it('marks replayed: true on idempotent replay of revoke', async () => {
			const originalRevokedAt = '2026-09-08T12:00:00.000Z';
			const invitation: InstanceInvitationMetadata = {
				id: VALID_UUID_1,
				role: 'admin',
				status: 'revoked',
				invitedByUserId: 'inviter-user-1',
				createdAt: '2026-09-01T00:00:00.000Z',
				expiresAt: '2026-09-08T00:00:00.000Z',
				acceptedAt: null,
				acceptedByUserId: null,
				revokedAt: originalRevokedAt,
				revokedByUserId: 'inviter-user-1'
			};
			const store = new FakeInstanceStore([], [], [], [{ outcome: 'replayed', invitation }]);
			const app = createTestApp(store);

			const result = await app.revoke(ACTOR, VALID_UUID_1, {
				idempotencyKey: 'revoke-replay-1'
			});

			expect(result.outcome).toBe('replayed');
			if (result.outcome === 'replayed') {
				expect(result.replayed).toBe(true);
				expect(result.invitation.revokedAt).toBe(originalRevokedAt);
			}
		});

		it('rejects invalid target ID on revoke', async () => {
			const store = new FakeInstanceStore();
			const app = createTestApp(store);

			await expect(app.revoke(ACTOR, 'not-a-uuid', { idempotencyKey: 'key-1' })).rejects.toThrow(
				InvalidInstanceInvitationRequestError
			);

			// Uppercase UUID
			await expect(
				app.revoke(ACTOR, '01900000-0000-7000-8000-00000000020A', { idempotencyKey: 'key-1' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// UUIDv4 (not v7)
			await expect(
				app.revoke(ACTOR, '9f1c6f8e-0a1d-4f3b-8b0e-7c2f9a4d6e11', { idempotencyKey: 'key-1' })
			).rejects.toThrow(InvalidInstanceInvitationRequestError);

			// Empty string
			await expect(app.revoke(ACTOR, '', { idempotencyKey: 'key-1' })).rejects.toThrow(
				InvalidInstanceInvitationRequestError
			);

			expect(store.revokeCommands).toHaveLength(0);
		});

		it('forwards other revoke store outcomes (forbidden, invitation_invalid, idempotency_conflict, member_suspended, integrity_error)', async () => {
			const outcomes: RevokeInstanceInvitationStoreResult[] = [
				{ outcome: 'forbidden' },
				{ outcome: 'invitation_invalid' },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'member_suspended' },
				{ outcome: 'integrity_error' }
			];

			for (const storeResult of outcomes) {
				const store = new FakeInstanceStore([], [], [], [storeResult]);
				const app = createTestApp(store);

				const result = await app.revoke(ACTOR, VALID_UUID_1, { idempotencyKey: 'key' });
				expect(result.outcome).toBe(storeResult.outcome);
			}
		});
	});

	describe('canonicalJson and deterministic ordering', () => {
		it('sorts object keys recursively and deterministically', () => {
			const a = { z: 1, a: 2, m: { y: 'hello', b: 'world' } };
			const b = { a: 2, m: { b: 'world', y: 'hello' }, z: 1 };

			expect(canonicalJson(a)).toBe(canonicalJson(b));
			expect(canonicalJson(a)).toBe('{"a":2,"m":{"b":"world","y":"hello"},"z":1}');
		});

		it('handles arrays and primitives in canonicalJson', () => {
			expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
			expect(canonicalJson('str')).toBe('"str"');
			expect(canonicalJson(123)).toBe('123');
			expect(canonicalJson(null)).toBe('null');
			expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
		});
	});

	describe('aliases and dependency injection', () => {
		it('supports InstanceInvitationService alias and method aliases', async () => {
			const store = new FakeInstanceStore();
			const service = new InstanceInvitationService(store, () => NOW);

			const createRes = await service.createInstanceInvitation(ACTOR, {
				idempotencyKey: 'alias-1',
				email: 'alice@example.com',
				role: 'admin'
			});
			expect(createRes.outcome).toBe('created');

			const listRes = await service.listInstanceInvitations(ACTOR);
			expect(listRes.outcome).toBe('listed');

			const token = (createRes as { token: string }).token;
			const acceptRes = await service.acceptInstanceInvitation(ACCEPTOR_ACTOR, {
				idempotencyKey: 'alias-2',
				token,
				email: 'alice@example.com'
			});
			expect(acceptRes.outcome).toBe('accepted');

			const revokeRes = await service.revokeInstanceInvitation(ACTOR, VALID_UUID_1, {
				idempotencyKey: 'alias-3'
			});
			expect(revokeRes.outcome).toBe('revoked');
		});

		it('supports constructor with positional arguments', () => {
			const store = new FakeInstanceStore();
			const app = new InstanceInvitationApplication(store);
			expect(app).toBeDefined();
		});
	});
});
