import {
	boundWorkloadKeyListLimit,
	isWorkloadKeyId,
	isWorkloadKeyIdempotencyKey,
	type CreateWorkloadKeyStoreResult,
	type RevokeWorkloadKeyStoreResult,
	type WorkloadKeyListPage,
	type WorkloadKeyListQuery,
	type WorkloadKeyMetadata,
	type WorkloadKeyStore
} from '$lib/ports/workload-key-store';
import {
	canonicalizeWorkloadKeyScopes,
	issueWorkloadKey,
	resolveWorkloadKeyExpiresAt,
	validateWorkloadKeyName,
	type IssuedWorkloadKey,
	type WorkloadKeyScope
} from '$lib/security/workload-key';

/**
 * A create attempt only repeats when the store reports that the generated UUID
 * or the credential hash already exists. Both are astronomically unlikely, so a
 * small bound is enough to absorb them without masking a real fault.
 */
const MAX_CREDENTIAL_ATTEMPTS: number = 3;

export interface WorkloadKeyRequestActor {
	id: string;
	organizationId: string;
	organizationName: string;
}

export interface CreateWorkloadKeyInput {
	idempotencyKey: string;
	name: string;
	scopes: readonly string[];
	/** Omit for the 90 day default. `null` is rejected: workload keys must expire. */
	expiresAt?: string | null;
}

export interface RevokeWorkloadKeyInput {
	idempotencyKey: string;
}

/**
 * Public create outcomes.
 *
 * `created` is the only outcome that carries the plaintext `signkit_` secret, and
 * it is returned exactly once, in memory. An exact idempotent replay resolves to
 * `already_issued` with metadata only: the original secret is unrecoverable and
 * a replacement is never minted or revealed.
 */
export type CreateWorkloadKeyResult =
	| { outcome: 'created'; key: WorkloadKeyMetadata; token: string }
	| { outcome: 'already_issued'; key: WorkloadKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'integrity_error' };

/** Public revoke outcomes. Unknown and cross-tenant keys are both `not_found`. */
export type RevokeWorkloadKeyResult =
	| { outcome: 'revoked'; key: WorkloadKeyMetadata }
	| { outcome: 'replayed'; key: WorkloadKeyMetadata }
	| { outcome: 'already_revoked'; key: WorkloadKeyMetadata }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'integrity_error' };

export interface WorkloadKeyApplicationPort {
	createWorkloadKey(
		actor: WorkloadKeyRequestActor,
		input: CreateWorkloadKeyInput
	): Promise<CreateWorkloadKeyResult>;
	listWorkloadKeys(
		actor: WorkloadKeyRequestActor,
		query: WorkloadKeyListQuery
	): Promise<WorkloadKeyListPage>;
	revokeWorkloadKey(
		actor: WorkloadKeyRequestActor,
		workloadKeyId: string,
		input: RevokeWorkloadKeyInput
	): Promise<RevokeWorkloadKeyResult>;
}

/** Rejected before any durable work, so no partial state can be observed. */
export class InvalidWorkloadKeyRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidWorkloadKeyRequestError';
	}
}

/**
 * Organization-scoped workload key management.
 *
 * The service owns request normalization, the request fingerprint, credential
 * generation, and the bounded collision retry. The fingerprint covers only the
 * caller's normalized request — canonical name, canonical scopes, and the
 * requested expiry as asked for rather than as resolved — so a retry after a
 * lost response hashes identically and replays instead of conflicting.
 */
export class WorkloadKeyApplication implements WorkloadKeyApplicationPort {
	constructor(
		private readonly store: WorkloadKeyStore,
		private readonly now: () => Date = (): Date => new Date(),
		private readonly issue: () => Promise<IssuedWorkloadKey> = issueWorkloadKey,
		private readonly uuid: () => string = (): string => crypto.randomUUID()
	) {}

	async createWorkloadKey(
		actor: WorkloadKeyRequestActor,
		input: CreateWorkloadKeyInput
	): Promise<CreateWorkloadKeyResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const name: string = normalize(
			(): string => validateWorkloadKeyName(input.name),
			'Invalid workload key name'
		);
		const scopes: readonly WorkloadKeyScope[] = normalize(
			(): readonly WorkloadKeyScope[] => canonicalizeWorkloadKeyScopes(input.scopes),
			'Workload key scopes must be a nonempty unique subset'
		);
		const now: Date = this.now();
		const expiresAt: string = normalize(
			(): string => resolveWorkloadKeyExpiresAt(now, input.expiresAt),
			'Invalid workload key expiry'
		);
		const createdAt: string = now.toISOString();
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				expiresAt: input.expiresAt === undefined ? null : expiresAt,
				name,
				scopes
			})
		);

		for (let attempt: number = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
			const workloadKeyId: string = this.uuid();
			if (!isWorkloadKeyId(workloadKeyId)) {
				throw new Error('Generated workload key id is not a canonical UUID');
			}
			const issued: IssuedWorkloadKey = await this.issue();
			const result: CreateWorkloadKeyStoreResult = await this.store.createWorkloadKey({
				organizationId: actor.organizationId,
				organizationName: actor.organizationName,
				actor: { type: 'user', id: actor.id },
				idempotencyKey,
				requestFingerprint,
				workloadKeyId,
				name,
				scopes,
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix,
				createdAt,
				expiresAt
			});
			switch (result.outcome) {
				case 'created':
					return { outcome: 'created', key: result.key, token: issued.token };
				case 'key_id_conflict':
				case 'token_hash_conflict':
					continue;
				default:
					return result;
			}
		}

		throw new Error('Workload key credential generation exhausted its collision retries');
	}

	async listWorkloadKeys(
		actor: WorkloadKeyRequestActor,
		query: WorkloadKeyListQuery
	): Promise<WorkloadKeyListPage> {
		// A malformed cursor can never identify a key row, so it fails closed here
		// exactly as an unknown or cross-tenant cursor does in the stores.
		if (query.cursor !== null && !isWorkloadKeyId(query.cursor)) {
			return { items: [], nextCursor: null };
		}
		return await this.store.listWorkloadKeys(actor.organizationId, {
			cursor: query.cursor,
			limit: boundWorkloadKeyListLimit(query.limit)
		});
	}

	async revokeWorkloadKey(
		actor: WorkloadKeyRequestActor,
		workloadKeyId: string,
		input: RevokeWorkloadKeyInput
	): Promise<RevokeWorkloadKeyResult> {
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		// An id that cannot exist is answered opaquely, never as a validation hint.
		if (!isWorkloadKeyId(workloadKeyId)) return { outcome: 'not_found' };
		const requestFingerprint: string = await sha256(JSON.stringify({ workloadKeyId }));
		const result: RevokeWorkloadKeyStoreResult = await this.store.revokeWorkloadKey({
			organizationId: actor.organizationId,
			actor: { type: 'user', id: actor.id },
			idempotencyKey,
			requestFingerprint,
			workloadKeyId,
			revokedAt: this.now().toISOString()
		});
		return result;
	}
}

function assertIdempotencyKey(idempotencyKey: string): string {
	if (!isWorkloadKeyIdempotencyKey(idempotencyKey)) {
		throw new InvalidWorkloadKeyRequestError('Invalid workload key idempotency key');
	}
	return idempotencyKey;
}

function normalize<T>(normalizer: () => T, fallbackMessage: string): T {
	try {
		return normalizer();
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : fallbackMessage;
		throw new InvalidWorkloadKeyRequestError(message);
	}
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
