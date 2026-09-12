import { describe, expect, it } from 'vitest';
import type {
	CreateWorkloadKeyCommand,
	CreateWorkloadKeyStoreResult,
	RevokeWorkloadKeyCommand,
	RevokeWorkloadKeyStoreResult,
	WorkloadKeyListPage,
	WorkloadKeyListQuery,
	WorkloadKeyMetadata,
	WorkloadKeyStore
} from '$lib/ports/workload-key-store';
import {
	hashWorkloadKey,
	isWorkloadKey,
	workloadKeyDisplayPrefix,
	WORKLOAD_KEY_DEFAULT_EXPIRY_MS,
	type IssuedWorkloadKey,
	type WorkloadKeyScope
} from '$lib/security/workload-key';
import {
	InvalidWorkloadKeyRequestError,
	WorkloadKeyApplication,
	type CreateWorkloadKeyInput,
	type CreateWorkloadKeyResult,
	type RevokeWorkloadKeyResult,
	type WorkloadKeyRequestActor
} from './workload-key-service';

const ACTOR: WorkloadKeyRequestActor = {
	id: 'user-1',
	organizationId: 'org-1',
	organizationName: 'Workspace'
};
const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';

class FakeWorkloadKeyStore implements WorkloadKeyStore {
	readonly createCommands: CreateWorkloadKeyCommand[] = [];
	readonly revokeCommands: RevokeWorkloadKeyCommand[] = [];
	readonly listCalls: { organizationId: string; query: WorkloadKeyListQuery }[] = [];
	page: WorkloadKeyListPage = { items: [], nextCursor: null };
	readonly #createResults: CreateWorkloadKeyStoreResult[];
	readonly #revokeResults: RevokeWorkloadKeyStoreResult[];

	constructor(
		createResults: readonly CreateWorkloadKeyStoreResult[] = [],
		revokeResults: readonly RevokeWorkloadKeyStoreResult[] = []
	) {
		this.#createResults = [...createResults];
		this.#revokeResults = [...revokeResults];
	}

	async createWorkloadKey(
		command: CreateWorkloadKeyCommand
	): Promise<CreateWorkloadKeyStoreResult> {
		this.createCommands.push(command);
		const scripted: CreateWorkloadKeyStoreResult | undefined = this.#createResults.shift();
		return scripted ?? { outcome: 'created', key: metadataFromCommand(command) };
	}

	async listWorkloadKeys(
		organizationId: string,
		query: WorkloadKeyListQuery
	): Promise<WorkloadKeyListPage> {
		this.listCalls.push({ organizationId, query });
		return this.page;
	}

	async revokeWorkloadKey(
		command: RevokeWorkloadKeyCommand
	): Promise<RevokeWorkloadKeyStoreResult> {
		this.revokeCommands.push(command);
		const scripted: RevokeWorkloadKeyStoreResult | undefined = this.#revokeResults.shift();
		return scripted ?? { outcome: 'revoked', key: metadata({ revokedAt: command.revokedAt }) };
	}
}

function metadataFromCommand(command: CreateWorkloadKeyCommand): WorkloadKeyMetadata {
	return {
		id: command.workloadKeyId,
		name: command.name,
		keyPrefix: command.keyPrefix,
		scopes: command.scopes,
		createdAt: command.createdAt,
		expiresAt: command.expiresAt,
		lastUsedAt: null,
		revokedAt: null
	};
}

function metadata(overrides: Partial<WorkloadKeyMetadata> = {}): WorkloadKeyMetadata {
	return {
		id: KEY_ID,
		name: 'CI agent',
		keyPrefix: 'signkit_abcdefgh',
		scopes: ['audit:read', 'envelopes:send'],
		createdAt: '2026-09-12T12:00:00.000Z',
		expiresAt: '2026-12-11T12:00:00.000Z',
		lastUsedAt: null,
		revokedAt: null,
		...overrides
	};
}

function application(
	store: FakeWorkloadKeyStore,
	options: { now?: Date | (() => Date); uuids?: readonly string[] } = {}
): WorkloadKeyApplication {
	const now: Date | (() => Date) = options.now ?? NOW;
	const clock: () => Date = typeof now === 'function' ? now : (): Date => now;
	const uuids: string[] = [
		...(options.uuids ?? [KEY_ID, OTHER_KEY_ID, 'fffffff0-0000-4000-8000-000000000003'])
	];
	return new WorkloadKeyApplication(store, clock, undefined, (): string => uuids.shift() ?? KEY_ID);
}

function createInput(overrides: Partial<CreateWorkloadKeyInput> = {}): CreateWorkloadKeyInput {
	return {
		idempotencyKey: 'create-1',
		name: 'CI agent',
		scopes: ['envelopes:send', 'audit:read'],
		...overrides
	};
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

describe('WorkloadKeyApplication.createWorkloadKey', () => {
	it('canonicalizes the request, defaults expiry to 90 days, and returns the secret once', async () => {
		const store = new FakeWorkloadKeyStore();
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput({ name: '  CI agent  ' })
		);

		expect(store.createCommands).toHaveLength(1);
		const command: CreateWorkloadKeyCommand = store.createCommands[0];
		expect(command.organizationId).toBe('org-1');
		expect(command.organizationName).toBe('Workspace');
		expect(command.actor).toEqual({ type: 'user', id: 'user-1' });
		expect(command.idempotencyKey).toBe('create-1');
		expect(command.workloadKeyId).toBe(KEY_ID);
		expect(command.name).toBe('CI agent');
		expect(command.scopes).toEqual(['audit:read', 'envelopes:send']);
		expect(command.createdAt).toBe('2026-09-12T12:00:00.000Z');
		expect(command.expiresAt).toBe('2026-12-11T12:00:00.000Z');
		expect(Date.parse(command.expiresAt) - Date.parse(command.createdAt)).toBe(
			WORKLOAD_KEY_DEFAULT_EXPIRY_MS
		);
		expect(command.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);

		expect(result.outcome).toBe('created');
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(isWorkloadKey(result.token)).toBe(true);
		expect(command.tokenHash).toBe(await hashWorkloadKey(result.token));
		expect(command.keyPrefix).toBe(workloadKeyDisplayPrefix(result.token));
		expect(result.key).toEqual({
			id: KEY_ID,
			name: 'CI agent',
			keyPrefix: command.keyPrefix,
			scopes: ['audit:read', 'envelopes:send'],
			createdAt: '2026-09-12T12:00:00.000Z',
			expiresAt: '2026-12-11T12:00:00.000Z',
			lastUsedAt: null,
			revokedAt: null
		});
	});

	it('never hands the plaintext secret to the store', async () => {
		const store = new FakeWorkloadKeyStore();
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput()
		);
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(JSON.stringify(store.createCommands)).not.toContain(result.token);
		expect(JSON.stringify(store.createCommands)).toContain(result.key.keyPrefix);
	});

	it('fingerprints the normalized request over name, scopes, and the requested expiry', async () => {
		const store = new FakeWorkloadKeyStore();
		await application(store).createWorkloadKey(ACTOR, createInput({ name: ' CI agent ' }));
		const expected: string = await sha256(
			JSON.stringify({
				expiresAt: null,
				name: 'CI agent',
				scopes: ['audit:read', 'envelopes:send']
			})
		);
		expect(store.createCommands[0].requestFingerprint).toBe(expected);
	});

	it('keeps the default-expiry fingerprint stable as the clock moves so a retry replays', async () => {
		const store = new FakeWorkloadKeyStore([
			{ outcome: 'created', key: metadata() },
			{ outcome: 'already_issued', key: metadata() }
		]);
		const later: Date = new Date('2026-09-12T12:30:00.000Z');
		let clock: Date = NOW;
		const service: WorkloadKeyApplication = application(store, { now: (): Date => clock });
		await service.createWorkloadKey(ACTOR, createInput());
		clock = later;
		await service.createWorkloadKey(
			ACTOR,
			createInput({ scopes: ['audit:read', 'envelopes:send'] })
		);

		expect(store.createCommands[0].requestFingerprint).toBe(
			store.createCommands[1].requestFingerprint
		);
		expect(store.createCommands[0].expiresAt).not.toBe(store.createCommands[1].expiresAt);
	});

	it('separates fingerprints for different names, scopes, and expiries', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store, {
			uuids: [KEY_ID, OTHER_KEY_ID, 'fffffff0-0000-4000-8000-000000000003', KEY_ID]
		});
		await service.createWorkloadKey(ACTOR, createInput());
		await service.createWorkloadKey(ACTOR, createInput({ name: 'Other agent' }));
		await service.createWorkloadKey(ACTOR, createInput({ scopes: ['audit:read'] }));
		await service.createWorkloadKey(ACTOR, createInput({ expiresAt: '2026-12-11T12:00:00.000Z' }));

		const fingerprints: string[] = store.createCommands.map(
			(command: CreateWorkloadKeyCommand): string => command.requestFingerprint
		);
		expect(new Set(fingerprints).size).toBe(4);
	});

	it('accepts an explicit expiry up to 365 days and rejects longer, past, missing, or malformed ones', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store);
		const accepted: CreateWorkloadKeyResult = await service.createWorkloadKey(
			ACTOR,
			createInput({ expiresAt: '2027-09-12T12:00:00.000Z' })
		);
		expect(accepted.outcome).toBe('created');
		expect(store.createCommands[0].expiresAt).toBe('2027-09-12T12:00:00.000Z');

		await expect(
			service.createWorkloadKey(ACTOR, createInput({ expiresAt: '2027-09-12T12:00:00.001Z' }))
		).rejects.toThrow('Workload key expiry must be at most 365 days');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ expiresAt: '2026-09-12T12:00:00.000Z' }))
		).rejects.toThrow('Workload key expiry must be in the future');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ expiresAt: null }))
		).rejects.toThrow('Workload keys must expire');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ expiresAt: 'tomorrow' }))
		).rejects.toThrow('Invalid workload key expiry');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ expiresAt: null }))
		).rejects.toBeInstanceOf(InvalidWorkloadKeyRequestError);
		expect(store.createCommands).toHaveLength(1);
	});

	it('rejects invalid names and scopes before any durable work', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store);

		await expect(service.createWorkloadKey(ACTOR, createInput({ name: '   ' }))).rejects.toThrow(
			'Invalid workload key name'
		);
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ name: 'a'.repeat(201) }))
		).rejects.toThrow('Invalid workload key name');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ name: 'tab\tname' }))
		).rejects.toThrow('Invalid workload key name');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ name: 'signkit_looks-like-a-secret' }))
		).rejects.toThrow('Invalid workload key name');
		await expect(service.createWorkloadKey(ACTOR, createInput({ scopes: [] }))).rejects.toThrow(
			'Workload key scopes must be a nonempty unique subset'
		);
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ scopes: ['audit:read', 'audit:read'] }))
		).rejects.toThrow('Workload key scopes must be a nonempty unique subset');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ scopes: ['secrets:read'] }))
		).rejects.toThrow('Workload key scopes must be a nonempty unique subset');
		await expect(
			service.createWorkloadKey(ACTOR, createInput({ name: '   ' }))
		).rejects.toBeInstanceOf(InvalidWorkloadKeyRequestError);
		expect(store.createCommands).toEqual([]);
	});

	it('rejects unbounded or non-printable idempotency keys', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store);

		for (const idempotencyKey of ['', 'a'.repeat(201), 'has space', 'line\nbreak', '鍵']) {
			await expect(
				service.createWorkloadKey(ACTOR, createInput({ idempotencyKey }))
			).rejects.toThrow('Invalid workload key idempotency key');
		}
		const accepted: CreateWorkloadKeyResult = await service.createWorkloadKey(
			ACTOR,
			createInput({ idempotencyKey: 'a'.repeat(200) })
		);
		expect(accepted.outcome).toBe('created');
		expect(store.createCommands).toHaveLength(1);
	});

	it('returns already_issued metadata without minting or revealing a replacement secret', async () => {
		const issued: WorkloadKeyMetadata = metadata({ lastUsedAt: '2026-09-12T13:00:00.000Z' });
		const store = new FakeWorkloadKeyStore([{ outcome: 'already_issued', key: issued }]);
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput()
		);

		expect(result).toEqual({ outcome: 'already_issued', key: issued });
		expect(Object.keys(result)).not.toContain('token');
		expect(store.createCommands).toHaveLength(1);
	});

	it('reports already_issued even when the originally issued key was since revoked', async () => {
		const revoked: WorkloadKeyMetadata = metadata({ revokedAt: '2026-09-12T12:30:00.000Z' });
		const store = new FakeWorkloadKeyStore([{ outcome: 'already_issued', key: revoked }]);
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput()
		);
		expect(result).toEqual({ outcome: 'already_issued', key: revoked });
	});

	it('passes idempotency conflicts and integrity errors through unchanged', async () => {
		const store = new FakeWorkloadKeyStore([
			{ outcome: 'idempotency_conflict' },
			{ outcome: 'integrity_error' }
		]);
		const service: WorkloadKeyApplication = application(store);
		await expect(service.createWorkloadKey(ACTOR, createInput())).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
		await expect(service.createWorkloadKey(ACTOR, createInput())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(store.createCommands).toHaveLength(2);
	});

	it('retries credential collisions with fresh material and keeps the request stable', async () => {
		const store = new FakeWorkloadKeyStore([
			{ outcome: 'token_hash_conflict' },
			{ outcome: 'key_id_conflict' }
		]);
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput()
		);

		expect(result.outcome).toBe('created');
		expect(store.createCommands).toHaveLength(3);
		const ids: string[] = store.createCommands.map(
			(command: CreateWorkloadKeyCommand): string => command.workloadKeyId
		);
		const hashes: string[] = store.createCommands.map(
			(command: CreateWorkloadKeyCommand): string => command.tokenHash
		);
		expect(new Set(ids).size).toBe(3);
		expect(new Set(hashes).size).toBe(3);
		expect(
			new Set(
				store.createCommands.map(
					(command: CreateWorkloadKeyCommand): string => command.requestFingerprint
				)
			).size
		).toBe(1);
		expect(
			new Set(
				store.createCommands.map((command: CreateWorkloadKeyCommand): string => command.createdAt)
			).size
		).toBe(1);
	});

	it('never converts an exact replay into a retry', async () => {
		const store = new FakeWorkloadKeyStore([
			{ outcome: 'token_hash_conflict' },
			{ outcome: 'already_issued', key: metadata() }
		]);
		const result: CreateWorkloadKeyResult = await application(store).createWorkloadKey(
			ACTOR,
			createInput()
		);
		expect(result).toEqual({ outcome: 'already_issued', key: metadata() });
		expect(store.createCommands).toHaveLength(2);
	});

	it('fails loudly after bounded collision retries without leaking credential material', async () => {
		const store = new FakeWorkloadKeyStore([
			{ outcome: 'token_hash_conflict' },
			{ outcome: 'token_hash_conflict' },
			{ outcome: 'token_hash_conflict' }
		]);
		await expect(application(store).createWorkloadKey(ACTOR, createInput())).rejects.toThrow(
			'Workload key credential generation exhausted its collision retries'
		);
		expect(store.createCommands).toHaveLength(3);
		try {
			await application(
				new FakeWorkloadKeyStore([
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' }
				])
			).createWorkloadKey(ACTOR, createInput());
			expect.unreachable('exhausted retries should throw');
		} catch (error: unknown) {
			expect((error as Error).message).not.toContain('signkit_');
		}
	});

	it('refuses a generated key id that is not a canonical UUID', async () => {
		const store = new FakeWorkloadKeyStore();
		const service = new WorkloadKeyApplication(
			store,
			(): Date => NOW,
			undefined,
			(): string => 'NOT-A-UUID'
		);
		await expect(service.createWorkloadKey(ACTOR, createInput())).rejects.toThrow(
			'Generated workload key id is not a canonical UUID'
		);
		expect(store.createCommands).toEqual([]);
	});

	it('uses the injected credential issuer for the token, hash, and display prefix', async () => {
		const store = new FakeWorkloadKeyStore();
		const token: string = 'signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		const issued: IssuedWorkloadKey = {
			token,
			tokenHash: await hashWorkloadKey(token),
			keyPrefix: workloadKeyDisplayPrefix(token)
		};
		const service = new WorkloadKeyApplication(
			store,
			(): Date => NOW,
			async (): Promise<IssuedWorkloadKey> => issued,
			(): string => KEY_ID
		);
		const result: CreateWorkloadKeyResult = await service.createWorkloadKey(ACTOR, createInput());
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(result.token).toBe(token);
		expect(store.createCommands[0].tokenHash).toBe(issued.tokenHash);
		expect(store.createCommands[0].keyPrefix).toBe('signkit_abcdefgh');
	});
});

describe('WorkloadKeyApplication.listWorkloadKeys', () => {
	it('scopes the query to the actor organization and bounds the limit to 100', async () => {
		const store = new FakeWorkloadKeyStore();
		await application(store).listWorkloadKeys(ACTOR, { cursor: null, limit: 1000 });
		expect(store.listCalls).toEqual([
			{ organizationId: 'org-1', query: { cursor: null, limit: 100 } }
		]);
	});

	it('clamps non-positive and non-integer limits', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store);
		await service.listWorkloadKeys(ACTOR, { cursor: null, limit: 0 });
		await service.listWorkloadKeys(ACTOR, { cursor: null, limit: Number.NaN });
		await service.listWorkloadKeys(ACTOR, { cursor: null, limit: 25 });
		expect(
			store.listCalls.map((call: { query: WorkloadKeyListQuery }): number => call.query.limit)
		).toEqual([1, 1, 25]);
	});

	it('passes a well-formed cursor through and returns only the allowlisted projection', async () => {
		const store = new FakeWorkloadKeyStore();
		store.page = {
			items: [metadata(), metadata({ id: OTHER_KEY_ID, revokedAt: '2026-09-12T13:00:00.000Z' })],
			nextCursor: OTHER_KEY_ID
		};
		const page: WorkloadKeyListPage = await application(store).listWorkloadKeys(ACTOR, {
			cursor: KEY_ID,
			limit: 2
		});

		expect(store.listCalls[0].query.cursor).toBe(KEY_ID);
		expect(page.nextCursor).toBe(OTHER_KEY_ID);
		for (const item of page.items) {
			expect(Object.keys(item).sort()).toEqual([
				'createdAt',
				'expiresAt',
				'id',
				'keyPrefix',
				'lastUsedAt',
				'name',
				'revokedAt',
				'scopes'
			]);
		}
	});

	it('fails closed on a malformed cursor without querying the store', async () => {
		const store = new FakeWorkloadKeyStore();
		store.page = { items: [metadata()], nextCursor: null };
		await expect(
			application(store).listWorkloadKeys(ACTOR, { cursor: 'not-a-uuid', limit: 10 })
		).resolves.toEqual({ items: [], nextCursor: null });
		expect(store.listCalls).toEqual([]);
	});
});

describe('WorkloadKeyApplication.revokeWorkloadKey', () => {
	it('sends a tenant-scoped revoke command fingerprinted over the key id', async () => {
		const store = new FakeWorkloadKeyStore();
		const result: RevokeWorkloadKeyResult = await application(store).revokeWorkloadKey(
			ACTOR,
			KEY_ID,
			{ idempotencyKey: 'revoke-1' }
		);

		expect(store.revokeCommands).toHaveLength(1);
		const command: RevokeWorkloadKeyCommand = store.revokeCommands[0];
		expect(command.organizationId).toBe('org-1');
		expect(command.actor).toEqual({ type: 'user', id: 'user-1' });
		expect(command.idempotencyKey).toBe('revoke-1');
		expect(command.workloadKeyId).toBe(KEY_ID);
		expect(command.revokedAt).toBe('2026-09-12T12:00:00.000Z');
		expect(command.requestFingerprint).toBe(
			await sha256(JSON.stringify({ workloadKeyId: KEY_ID }))
		);
		expect(result.outcome).toBe('revoked');
	});

	it('keeps the revoke fingerprint stable over time and distinct per key', async () => {
		const store = new FakeWorkloadKeyStore();
		let clock: Date = NOW;
		const service: WorkloadKeyApplication = application(store, { now: (): Date => clock });
		await service.revokeWorkloadKey(ACTOR, KEY_ID, { idempotencyKey: 'revoke-1' });
		clock = new Date('2026-09-12T12:45:00.000Z');
		await service.revokeWorkloadKey(ACTOR, KEY_ID, { idempotencyKey: 'revoke-1' });
		await service.revokeWorkloadKey(ACTOR, OTHER_KEY_ID, { idempotencyKey: 'revoke-2' });

		expect(store.revokeCommands[0].requestFingerprint).toBe(
			store.revokeCommands[1].requestFingerprint
		);
		expect(store.revokeCommands[1].revokedAt).toBe('2026-09-12T12:45:00.000Z');
		expect(store.revokeCommands[2].requestFingerprint).not.toBe(
			store.revokeCommands[0].requestFingerprint
		);
	});

	it('answers a malformed key id opaquely without touching the store', async () => {
		const store = new FakeWorkloadKeyStore();
		await expect(
			application(store).revokeWorkloadKey(ACTOR, 'not-a-uuid', { idempotencyKey: 'revoke-1' })
		).resolves.toEqual({ outcome: 'not_found' });
		expect(store.revokeCommands).toEqual([]);
	});

	it('rejects invalid idempotency keys before resolving the key id', async () => {
		const store = new FakeWorkloadKeyStore();
		await expect(
			application(store).revokeWorkloadKey(ACTOR, 'not-a-uuid', { idempotencyKey: '' })
		).rejects.toBeInstanceOf(InvalidWorkloadKeyRequestError);
		expect(store.revokeCommands).toEqual([]);
	});

	it('passes every durable revoke outcome through unchanged', async () => {
		const revoked: WorkloadKeyMetadata = metadata({ revokedAt: '2026-09-12T12:00:00.000Z' });
		const store = new FakeWorkloadKeyStore(
			[],
			[
				{ outcome: 'replayed', key: revoked },
				{ outcome: 'already_revoked', key: revoked },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'not_found' },
				{ outcome: 'integrity_error' }
			]
		);
		const service: WorkloadKeyApplication = application(store);
		const outcomes: RevokeWorkloadKeyResult[] = [];
		for (let attempt: number = 0; attempt < 5; attempt += 1) {
			outcomes.push(
				await service.revokeWorkloadKey(ACTOR, KEY_ID, { idempotencyKey: `revoke-${attempt}` })
			);
		}
		expect(outcomes).toEqual([
			{ outcome: 'replayed', key: revoked },
			{ outcome: 'already_revoked', key: revoked },
			{ outcome: 'idempotency_conflict' },
			{ outcome: 'not_found' },
			{ outcome: 'integrity_error' }
		]);
	});

	it('scopes revocation to the calling organization', async () => {
		const store = new FakeWorkloadKeyStore();
		await application(store).revokeWorkloadKey(
			{ id: 'user-2', organizationId: 'org-2', organizationName: 'Other' },
			KEY_ID,
			{ idempotencyKey: 'revoke-1' }
		);
		expect(store.revokeCommands[0].organizationId).toBe('org-2');
		expect(store.revokeCommands[0].actor.id).toBe('user-2');
	});
});

describe('WorkloadKeyApplication scope canonicalization', () => {
	it('orders every scope subset identically regardless of request order', async () => {
		const store = new FakeWorkloadKeyStore();
		const service: WorkloadKeyApplication = application(store, {
			uuids: [KEY_ID, OTHER_KEY_ID]
		});
		const requested: readonly WorkloadKeyScope[] = [
			'envelopes:send',
			'envelopes:read',
			'drafts:write',
			'audit:read'
		];
		await service.createWorkloadKey(ACTOR, createInput({ scopes: requested }));
		await service.createWorkloadKey(
			ACTOR,
			createInput({ idempotencyKey: 'create-2', scopes: [...requested].reverse() })
		);

		expect(store.createCommands[0].scopes).toEqual([
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		]);
		expect(store.createCommands[1].scopes).toEqual(store.createCommands[0].scopes);
		expect(store.createCommands[1].requestFingerprint).toBe(
			store.createCommands[0].requestFingerprint
		);
	});
});
