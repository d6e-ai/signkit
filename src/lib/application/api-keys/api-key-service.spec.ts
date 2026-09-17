import { describe, expect, it } from 'vitest';
import type {
	CreateApiKeyCommand,
	CreateApiKeyStoreResult,
	ListApiKeyStoreResult,
	RevokeApiKeyCommand,
	RevokeApiKeyStoreResult,
	ApiKeyActor,
	ApiKeyListPage,
	ApiKeyListQuery,
	ApiKeyMetadata,
	ApiKeyStore
} from '$lib/ports/api-key-store';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import {
	hashApiKey,
	isApiKey,
	apiKeyDisplayPrefix,
	API_KEY_DEFAULT_EXPIRY_MS,
	type IssuedApiKey,
	type ApiKeyScope
} from '$lib/security/api-key';
import {
	InvalidApiKeyRequestError,
	ApiKeyApplication,
	type CreateApiKeyInput,
	type CreateApiKeyResult,
	type ListApiKeyResult,
	type RevokeApiKeyResult,
	type ApiKeyRequestActor
} from './api-key-service';

const ACTOR: ApiKeyRequestActor = { id: 'user-1' };
const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';

class FakeApiKeyStore implements ApiKeyStore {
	readonly createCommands: CreateApiKeyCommand[] = [];
	readonly revokeCommands: RevokeApiKeyCommand[] = [];
	readonly listCalls: { actor: ApiKeyActor; query: ApiKeyListQuery }[] = [];
	listResult: ListApiKeyStoreResult = { outcome: 'listed', page: { items: [], nextCursor: null } };
	readonly #createResults: CreateApiKeyStoreResult[];
	readonly #revokeResults: RevokeApiKeyStoreResult[];

	constructor(
		createResults: readonly CreateApiKeyStoreResult[] = [],
		revokeResults: readonly RevokeApiKeyStoreResult[] = []
	) {
		this.#createResults = [...createResults];
		this.#revokeResults = [...revokeResults];
	}

	async createApiKey(command: CreateApiKeyCommand): Promise<CreateApiKeyStoreResult> {
		this.createCommands.push(command);
		const scripted: CreateApiKeyStoreResult | undefined = this.#createResults.shift();
		return scripted ?? { outcome: 'created', key: metadataFromCommand(command) };
	}

	async listApiKeys(actor: ApiKeyActor, query: ApiKeyListQuery): Promise<ListApiKeyStoreResult> {
		this.listCalls.push({ actor, query });
		return this.listResult;
	}

	async revokeApiKey(command: RevokeApiKeyCommand): Promise<RevokeApiKeyStoreResult> {
		this.revokeCommands.push(command);
		const scripted: RevokeApiKeyStoreResult | undefined = this.#revokeResults.shift();
		return scripted ?? { outcome: 'revoked', key: metadata({ revokedAt: command.revokedAt }) };
	}
}

function metadataFromCommand(command: CreateApiKeyCommand): ApiKeyMetadata {
	return {
		id: command.apiKeyId,
		name: command.name,
		keyPrefix: command.keyPrefix,
		scopes: command.scopes,
		createdAt: command.createdAt,
		expiresAt: command.expiresAt,
		lastUsedAt: null,
		revokedAt: null
	};
}

function metadata(overrides: Partial<ApiKeyMetadata> = {}): ApiKeyMetadata {
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
	store: FakeApiKeyStore,
	options: { now?: Date | (() => Date); uuids?: readonly string[] } = {}
): ApiKeyApplication {
	const now: Date | (() => Date) = options.now ?? NOW;
	const clock: () => Date = typeof now === 'function' ? now : (): Date => now;
	const uuids: string[] = [
		...(options.uuids ?? [KEY_ID, OTHER_KEY_ID, '01900000-0000-7000-8000-000000000203'])
	];
	return new ApiKeyApplication(store, clock, undefined, (): string => uuids.shift() ?? KEY_ID);
}

function createInput(overrides: Partial<CreateApiKeyInput> = {}): CreateApiKeyInput {
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

describe('ApiKeyApplication.createApiKey', () => {
	it('mints a canonical UUIDv7 record identifier by default, separate from the secret', async () => {
		const store = new FakeApiKeyStore();
		const result: CreateApiKeyResult = await new ApiKeyApplication(
			store,
			(): Date => NOW
		).createApiKey(ACTOR, createInput());

		const command: CreateApiKeyCommand = store.createCommands[0];
		expect(command.apiKeyId).toMatch(UUID_V7_PATTERN);
		expect(result.outcome).toBe('created');
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(result.key.id).toBe(command.apiKeyId);
		expect(result.token.startsWith('signkit_')).toBe(true);
		expect(result.token).not.toContain(command.apiKeyId);
	});

	it('forwards the owner actor without an organization scope', async () => {
		const store = new FakeApiKeyStore();
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());

		const command: CreateApiKeyCommand = store.createCommands[0];
		expect(command.actor).toEqual({ type: 'user', id: 'user-1' });
		expect(command).not.toHaveProperty('organizationId');
		expect(command).not.toHaveProperty('organizationName');
		expect(command.apiKeyId).toBe(KEY_ID);
		expect(command.name).toBe('CI agent');
		expect(command.scopes).toEqual(['audit:read', 'envelopes:send']);
		expect(command.createdAt).toBe('2026-09-12T12:00:00.000Z');
		expect(Date.parse(command.expiresAt) - NOW.valueOf()).toBe(API_KEY_DEFAULT_EXPIRY_MS);
		expect(result.outcome).toBe('created');
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(isApiKey(result.token)).toBe(true);
		expect(command.tokenHash).toBe(await hashApiKey(result.token));
		expect(command.keyPrefix).toBe(apiKeyDisplayPrefix(result.token));
		expect(result.token).not.toBe(command.tokenHash);
		expect(JSON.stringify(command)).not.toContain(result.token);
	});

	it('returns the plaintext secret only on created', async () => {
		const store = new FakeApiKeyStore();
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());
		expect(result.outcome).toBe('created');
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(typeof result.token).toBe('string');
		expect(result).toHaveProperty('token');
	});

	it('trims the name before persistence', async () => {
		const store = new FakeApiKeyStore();
		await application(store).createApiKey(ACTOR, createInput({ name: ' CI agent ' }));
		expect(store.createCommands[0].name).toBe('CI agent');
	});

	it('keeps the request fingerprint stable when only wall-clock time advances', async () => {
		const store = new FakeApiKeyStore([
			{ outcome: 'created', key: metadata() },
			{ outcome: 'created', key: metadata({ id: OTHER_KEY_ID }) }
		]);
		let clock: Date = NOW;
		const service: ApiKeyApplication = application(store, { now: (): Date => clock });
		await service.createApiKey(ACTOR, createInput());
		clock = new Date('2026-09-12T12:30:00.000Z');
		await service.createApiKey(ACTOR, createInput({ idempotencyKey: 'create-2' }));
		expect(store.createCommands[0].requestFingerprint).toBe(
			store.createCommands[1].requestFingerprint
		);
	});

	it('changes the fingerprint when name, scopes, or expiry change', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store, {
			uuids: [
				KEY_ID,
				OTHER_KEY_ID,
				'01900000-0000-7000-8000-000000000203',
				'01900000-0000-7000-8000-000000000204'
			]
		});
		await service.createApiKey(ACTOR, createInput());
		await service.createApiKey(ACTOR, createInput({ name: 'Other agent' }));
		await service.createApiKey(ACTOR, createInput({ scopes: ['audit:read'] }));
		await service.createApiKey(ACTOR, createInput({ expiresAt: '2026-12-11T12:00:00.000Z' }));
		const fingerprints: readonly string[] = store.createCommands.map(
			(command: CreateApiKeyCommand): string => command.requestFingerprint
		);
		expect(new Set(fingerprints).size).toBe(4);
	});

	it('rejects invalid expiry before touching the store', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store);
		const accepted: CreateApiKeyResult = await service.createApiKey(
			ACTOR,
			createInput({ expiresAt: '2027-09-12T12:00:00.000Z' })
		);
		expect(accepted.outcome).toBe('created');
		await expect(
			service.createApiKey(ACTOR, createInput({ expiresAt: '2027-09-12T12:00:00.001Z' }))
		).rejects.toThrow('API key expiry must be at most 365 days');
		await expect(
			service.createApiKey(ACTOR, createInput({ expiresAt: '2026-09-12T12:00:00.000Z' }))
		).rejects.toThrow('API key expiry must be in the future');
		await expect(service.createApiKey(ACTOR, createInput({ expiresAt: null }))).rejects.toThrow(
			'API keys must expire'
		);
		await expect(
			service.createApiKey(ACTOR, createInput({ expiresAt: 'tomorrow' }))
		).rejects.toThrow('Invalid API key expiry');
		await expect(
			service.createApiKey(ACTOR, createInput({ expiresAt: null }))
		).rejects.toBeInstanceOf(InvalidApiKeyRequestError);
		expect(store.createCommands).toHaveLength(1);
	});

	it('rejects invalid names and scopes before touching the store', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store);

		await expect(service.createApiKey(ACTOR, createInput({ name: '   ' }))).rejects.toThrow(
			'Invalid API key name'
		);
		await expect(
			service.createApiKey(ACTOR, createInput({ name: 'a'.repeat(201) }))
		).rejects.toThrow('Invalid API key name');
		await expect(service.createApiKey(ACTOR, createInput({ name: 'tab\tname' }))).rejects.toThrow(
			'Invalid API key name'
		);
		await expect(
			service.createApiKey(ACTOR, createInput({ name: 'signkit_looks-like-a-secret' }))
		).rejects.toThrow('Invalid API key name');
		await expect(service.createApiKey(ACTOR, createInput({ scopes: [] }))).rejects.toThrow(
			'API key scopes must be a nonempty unique subset'
		);
		await expect(
			service.createApiKey(ACTOR, createInput({ scopes: ['audit:read', 'audit:read'] }))
		).rejects.toThrow('API key scopes must be a nonempty unique subset');
		await expect(
			service.createApiKey(ACTOR, createInput({ scopes: ['secrets:read'] }))
		).rejects.toThrow('API key scopes must be a nonempty unique subset');
		await expect(service.createApiKey(ACTOR, createInput({ name: '   ' }))).rejects.toBeInstanceOf(
			InvalidApiKeyRequestError
		);
		expect(store.createCommands).toEqual([]);
	});

	it('rejects invalid idempotency keys before generating credentials', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store);
		for (const idempotencyKey of ['', 'has space', 'a'.repeat(201)]) {
			await expect(service.createApiKey(ACTOR, createInput({ idempotencyKey }))).rejects.toThrow(
				'Invalid API key idempotency key'
			);
		}
		const accepted: CreateApiKeyResult = await service.createApiKey(
			ACTOR,
			createInput({ idempotencyKey: 'create-ci-agent-1' })
		);
		expect(accepted.outcome).toBe('created');
		expect(store.createCommands).toHaveLength(1);
	});

	it('returns already_issued metadata without a replacement secret', async () => {
		const issued: ApiKeyMetadata = metadata({ lastUsedAt: '2026-09-12T13:00:00.000Z' });
		const store = new FakeApiKeyStore([{ outcome: 'already_issued', key: issued }]);
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());
		expect(result).toEqual({ outcome: 'already_issued', key: issued });
		expect(result).not.toHaveProperty('token');
	});

	it('returns already_issued even when the original key has since been revoked', async () => {
		const revoked: ApiKeyMetadata = metadata({ revokedAt: '2026-09-12T12:30:00.000Z' });
		const store = new FakeApiKeyStore([{ outcome: 'already_issued', key: revoked }]);
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());
		expect(result).toEqual({ outcome: 'already_issued', key: revoked });
	});

	it('passes owner_not_active and integrity outcomes through without retrying', async () => {
		const store = new FakeApiKeyStore([
			{ outcome: 'owner_not_active' },
			{ outcome: 'integrity_error' }
		]);
		const service: ApiKeyApplication = application(store);
		await expect(service.createApiKey(ACTOR, createInput())).resolves.toEqual({
			outcome: 'owner_not_active'
		});
		await expect(service.createApiKey(ACTOR, createInput())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(store.createCommands).toHaveLength(2);
	});

	it('retries a key id collision with a fresh identifier', async () => {
		const store = new FakeApiKeyStore([
			{ outcome: 'key_id_conflict' },
			{ outcome: 'created', key: metadata({ id: OTHER_KEY_ID }) }
		]);
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());
		expect(result.outcome).toBe('created');
		expect(
			store.createCommands.map((command: CreateApiKeyCommand): string => command.apiKeyId)
		).toEqual([KEY_ID, OTHER_KEY_ID]);
		expect(
			new Set(store.createCommands.map((command: CreateApiKeyCommand): string => command.tokenHash))
				.size
		).toBe(2);
		expect(
			new Set(
				store.createCommands.map(
					(command: CreateApiKeyCommand): string => command.requestFingerprint
				)
			).size
		).toBe(1);
		expect(
			new Set(store.createCommands.map((command: CreateApiKeyCommand): string => command.createdAt))
				.size
		).toBe(1);
	});

	it('retries a credential hash collision with fresh material', async () => {
		const store = new FakeApiKeyStore([
			{ outcome: 'token_hash_conflict' },
			{ outcome: 'created', key: metadata({ id: OTHER_KEY_ID }) }
		]);
		const result: CreateApiKeyResult = await application(store).createApiKey(ACTOR, createInput());
		expect(result.outcome).toBe('created');
		expect(store.createCommands).toHaveLength(2);
	});

	it('exhausts collision retries without leaking a token', async () => {
		await expect(
			application(
				new FakeApiKeyStore([
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' }
				])
			).createApiKey(ACTOR, createInput())
		).rejects.toThrow('API key credential generation exhausted its collision retries');
		try {
			await application(
				new FakeApiKeyStore([
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' },
					{ outcome: 'token_hash_conflict' }
				])
			).createApiKey(ACTOR, createInput());
			expect.unreachable('exhausted retries should throw');
		} catch (error: unknown) {
			expect((error as Error).message).not.toContain('signkit_');
		}
	});

	it('refuses a generated key id that is not a canonical UUID', async () => {
		const store = new FakeApiKeyStore();
		const service = new ApiKeyApplication(
			store,
			(): Date => NOW,
			undefined,
			(): string => 'NOT-A-UUID'
		);
		await expect(service.createApiKey(ACTOR, createInput())).rejects.toThrow(
			'Generated API key id is not a canonical UUIDv7'
		);
		expect(store.createCommands).toEqual([]);
	});

	it('uses the injected credential issuer for the token, hash, and display prefix', async () => {
		const store = new FakeApiKeyStore();
		const token: string = 'signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		const issued: IssuedApiKey = {
			token,
			tokenHash: await hashApiKey(token),
			keyPrefix: apiKeyDisplayPrefix(token)
		};
		const service = new ApiKeyApplication(
			store,
			(): Date => NOW,
			async (): Promise<IssuedApiKey> => issued,
			(): string => KEY_ID
		);
		const result: CreateApiKeyResult = await service.createApiKey(ACTOR, createInput());
		if (result.outcome !== 'created') expect.unreachable('create should succeed');
		expect(result.token).toBe(token);
		expect(store.createCommands[0].tokenHash).toBe(issued.tokenHash);
		expect(store.createCommands[0].keyPrefix).toBe('signkit_abcdefgh');
	});
});

describe('ApiKeyApplication.listApiKeys', () => {
	it('scopes the query to the actor user and bounds the limit to 100', async () => {
		const store = new FakeApiKeyStore();
		await application(store).listApiKeys(ACTOR, { cursor: null, limit: 1000 });
		expect(store.listCalls).toEqual([
			{ actor: { type: 'user', id: 'user-1' }, query: { cursor: null, limit: 100 } }
		]);
	});

	it('clamps non-positive and non-integer limits', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store);
		await service.listApiKeys(ACTOR, { cursor: null, limit: 0 });
		await service.listApiKeys(ACTOR, { cursor: null, limit: Number.NaN });
		await service.listApiKeys(ACTOR, { cursor: null, limit: 25 });
		expect(
			store.listCalls.map((call: { query: ApiKeyListQuery }): number => call.query.limit)
		).toEqual([1, 1, 25]);
	});

	it('passes a well-formed cursor through and returns only the allowlisted projection', async () => {
		const store = new FakeApiKeyStore();
		const page: ApiKeyListPage = {
			items: [metadata(), metadata({ id: OTHER_KEY_ID, revokedAt: '2026-09-12T13:00:00.000Z' })],
			nextCursor: OTHER_KEY_ID
		};
		store.listResult = { outcome: 'listed', page };
		const result: ListApiKeyResult = await application(store).listApiKeys(ACTOR, {
			cursor: KEY_ID,
			limit: 2
		});

		expect(store.listCalls[0].query.cursor).toBe(KEY_ID);
		expect(result).toEqual({ outcome: 'listed', page });
		if (result.outcome !== 'listed') expect.unreachable('list should succeed');
		for (const item of result.page.items) {
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

	it('delegates a malformed cursor to the store instead of failing closed locally', async () => {
		const store = new FakeApiKeyStore();
		store.listResult = { outcome: 'listed', page: { items: [], nextCursor: null } };
		await expect(
			application(store).listApiKeys(ACTOR, { cursor: 'not-a-uuid', limit: 10 })
		).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
		expect(store.listCalls).toEqual([
			{ actor: { type: 'user', id: 'user-1' }, query: { cursor: 'not-a-uuid', limit: 10 } }
		]);
	});

	it('surfaces owner_not_active for a malformed cursor instead of masking it as an empty list', async () => {
		const store = new FakeApiKeyStore();
		store.listResult = { outcome: 'owner_not_active' };
		await expect(
			application(store).listApiKeys(ACTOR, { cursor: 'not-a-uuid', limit: 10 })
		).resolves.toEqual({ outcome: 'owner_not_active' });
	});

	it('passes owner_not_active through from the store', async () => {
		const store = new FakeApiKeyStore();
		store.listResult = { outcome: 'owner_not_active' };
		await expect(
			application(store).listApiKeys(ACTOR, { cursor: null, limit: 10 })
		).resolves.toEqual({ outcome: 'owner_not_active' });
	});
});

describe('ApiKeyApplication.revokeApiKey', () => {
	it('sends an owner-scoped revoke command fingerprinted over the key id', async () => {
		const store = new FakeApiKeyStore();
		const result: RevokeApiKeyResult = await application(store).revokeApiKey(ACTOR, KEY_ID, {
			idempotencyKey: 'revoke-1'
		});

		expect(store.revokeCommands).toHaveLength(1);
		const command: RevokeApiKeyCommand = store.revokeCommands[0];
		expect(command).not.toHaveProperty('organizationId');
		expect(command.actor).toEqual({ type: 'user', id: 'user-1' });
		expect(command.idempotencyKey).toBe('revoke-1');
		expect(command.apiKeyId).toBe(KEY_ID);
		expect(command.revokedAt).toBe('2026-09-12T12:00:00.000Z');
		expect(command.requestFingerprint).toBe(await sha256(JSON.stringify({ apiKeyId: KEY_ID })));
		expect(result.outcome).toBe('revoked');
	});

	it('keeps the revoke fingerprint stable over time and distinct per key', async () => {
		const store = new FakeApiKeyStore();
		let clock: Date = NOW;
		const service: ApiKeyApplication = application(store, { now: (): Date => clock });
		await service.revokeApiKey(ACTOR, KEY_ID, { idempotencyKey: 'revoke-1' });
		clock = new Date('2026-09-12T12:45:00.000Z');
		await service.revokeApiKey(ACTOR, KEY_ID, { idempotencyKey: 'revoke-1' });
		await service.revokeApiKey(ACTOR, OTHER_KEY_ID, { idempotencyKey: 'revoke-2' });

		expect(store.revokeCommands[0].requestFingerprint).toBe(
			store.revokeCommands[1].requestFingerprint
		);
		expect(store.revokeCommands[1].revokedAt).toBe('2026-09-12T12:45:00.000Z');
		expect(store.revokeCommands[2].requestFingerprint).not.toBe(
			store.revokeCommands[0].requestFingerprint
		);
	});

	it('answers a malformed key id opaquely without touching the store', async () => {
		const store = new FakeApiKeyStore();
		await expect(
			application(store).revokeApiKey(ACTOR, 'not-a-uuid', { idempotencyKey: 'revoke-1' })
		).resolves.toEqual({ outcome: 'not_found' });
		expect(store.revokeCommands).toEqual([]);
	});

	it('rejects invalid idempotency keys before resolving the key id', async () => {
		const store = new FakeApiKeyStore();
		await expect(
			application(store).revokeApiKey(ACTOR, 'not-a-uuid', { idempotencyKey: '' })
		).rejects.toBeInstanceOf(InvalidApiKeyRequestError);
		expect(store.revokeCommands).toEqual([]);
	});

	it('passes every durable revoke outcome through unchanged', async () => {
		const revoked: ApiKeyMetadata = metadata({ revokedAt: '2026-09-12T12:00:00.000Z' });
		const store = new FakeApiKeyStore(
			[],
			[
				{ outcome: 'replayed', key: revoked },
				{ outcome: 'already_revoked', key: revoked },
				{ outcome: 'idempotency_conflict' },
				{ outcome: 'not_found' },
				{ outcome: 'owner_not_active' },
				{ outcome: 'integrity_error' }
			]
		);
		const service: ApiKeyApplication = application(store);
		const outcomes: RevokeApiKeyResult[] = [];
		for (let attempt: number = 0; attempt < 6; attempt += 1) {
			outcomes.push(
				await service.revokeApiKey(ACTOR, KEY_ID, { idempotencyKey: `revoke-${attempt}` })
			);
		}
		expect(outcomes).toEqual([
			{ outcome: 'replayed', key: revoked },
			{ outcome: 'already_revoked', key: revoked },
			{ outcome: 'idempotency_conflict' },
			{ outcome: 'not_found' },
			{ outcome: 'owner_not_active' },
			{ outcome: 'integrity_error' }
		]);
	});

	it('scopes revocation to the calling owner', async () => {
		const store = new FakeApiKeyStore();
		await application(store).revokeApiKey({ id: 'user-2' }, KEY_ID, { idempotencyKey: 'revoke-1' });
		expect(store.revokeCommands[0].actor.id).toBe('user-2');
	});
});

describe('ApiKeyApplication scope canonicalization', () => {
	it('orders every scope subset identically regardless of request order', async () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store, {
			uuids: [KEY_ID, OTHER_KEY_ID]
		});
		const requested: readonly ApiKeyScope[] = [
			'envelopes:send',
			'envelopes:read',
			'drafts:write',
			'audit:read'
		];
		await service.createApiKey(ACTOR, createInput({ scopes: requested }));
		await service.createApiKey(
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

describe('ApiKeyApplication instance boundary', () => {
	it('exposes only owner-scoped key management: create, list, and revoke', () => {
		const store = new FakeApiKeyStore();
		const service: ApiKeyApplication = application(store);

		expect(typeof service.createApiKey).toBe('function');
		expect(typeof service.listApiKeys).toBe('function');
		expect(typeof service.revokeApiKey).toBe('function');
		expect('grantApiKeyOrganization' in service).toBe(false);
		expect('listApiKeyOrganizationGrants' in service).toBe(false);
		expect('revokeApiKeyOrganizationGrant' in service).toBe(false);
	});
});
