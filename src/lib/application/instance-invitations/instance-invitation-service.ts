import {
	boundInstanceInvitationListLimit,
	DEFAULT_INSTANCE_INVITATION_LIST_LIMIT,
	isInstanceIdempotencyKey,
	isInstanceInvitationId,
	isInstanceInvitationListView,
	isInstanceMemberRole,
	MAX_RECEIVED_INSTANCE_INVITATIONS,
	resolveInstanceInvitationExpiresAt,
	type AcceptInstanceInvitationByRecipientCommand,
	type AcceptInstanceInvitationStoreResult,
	type CreateInstanceInvitationCommand,
	type CreateInstanceInvitationStoreResult,
	type InstanceActor,
	type InstanceInvitationListQuery,
	type InstanceInvitationListView,
	type InstanceInvitationMetadata,
	type InstanceMemberMetadata,
	type InstanceMemberRole,
	type InstanceStore,
	type ListInstanceInvitationsStoreResult,
	type ListReceivedInstanceInvitationsStoreResult,
	type RevokeInstanceInvitationCommand,
	type RevokeInstanceInvitationStoreResult,
	type SettleInstanceInvitationDeliveryStoreResult
} from '$lib/ports/instance-store';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	computeInstanceInvitationEmailBinding,
	issueInstanceInvitationToken,
	normalizeInstanceInvitationEmail,
	type IssuedInstanceInvitationToken
} from '$lib/security/instance-invitation';
import { canonicalJson, sha256Hex } from '$lib/application/instance/instance-command-fingerprint';
import type {
	InstanceInvitationDeliveryLocale,
	InstanceInvitationDeliveryPayloadSealer,
	InstanceInvitationRecipientLookups,
	InstanceInvitationRequestFingerprints
} from '$lib/security/instance-invitation-delivery-payload';
import type { InstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';

export { canonicalJson, sha256Hex };

/** Maximum collision retries for generated UUIDv7 or credential tokenHash collisions. */
const MAX_CREDENTIAL_ATTEMPTS: number = 3;

/**
 * Caller identity representation. Accepts either the full port `InstanceActor`
 * (`{ type: 'user', id }`) or an actor with `id` and optional `type: 'user'`.
 */
export interface InstanceInvitationActor {
	id: string;
	type?: 'user';
}

export interface CreateInstanceInvitationInput {
	idempotencyKey: string;
	email: string;
	role: InstanceMemberRole | string;
	locale?: InstanceInvitationDeliveryLocale;
	/**
	 * Omit for the fixed 7-day default. Null is rejected: instance invitations
	 * must expire and cannot exceed the fixed 7-day lifetime.
	 */
	expiresAt?: string | null;
	/**
	 * Holds the invitation's outbox row this long after creation while the
	 * create command sends the console note itself (see `settleDelivery`).
	 * Omitted or 0: the drain may deliver it at once. Not part of the request
	 * fingerprint.
	 */
	deliveryHoldMs?: number;
}

/**
 * After the create command's console note: `console` when D6E Auth holds it,
 * `self` when the drain must retry it.
 */
export type InstanceInvitationDeliveryHandoff = 'console' | 'self';

/**
 * Public create outcomes.
 *
 * Fresh creation (`created`) carries the one-time plaintext `ski1_` bearer token.
 * An exact idempotent replay resolves to `replayed` with `replayed: true` and
 * metadata only: the one-time token cannot be recovered, and a replacement is
 * never minted. All other store outcomes stay discriminated for HTTP mapping.
 */
export type CreateInstanceInvitationResult =
	| { outcome: 'created'; invitation: InstanceInvitationMetadata; replayed?: false }
	| {
			outcome: 'replayed';
			invitation: InstanceInvitationMetadata;
			replayed: true;
	  }
	| { outcome: 'forbidden' }
	| { outcome: 'role_not_permitted' }
	| { outcome: 'limit' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface ListInstanceInvitationsInput {
	cursor?: string | null;
	limit?: number;
	view?: InstanceInvitationListView;
}

export type ListInstanceInvitationsResult = ListInstanceInvitationsStoreResult;

/**
 * Public accept outcomes.
 *
 * `accepted` and `replayed` both resolve the current invitation and enrolled member.
 * `replayed: true` distinguishes an idempotent replay. `already_member` means the
 * caller was already a currently active instance member: the invitation was left
 * pending and unconsumed, and only the caller's own current member metadata is
 * returned, never invitation data.
 */
export type AcceptInstanceInvitationResult =
	| {
			outcome: 'accepted';
			invitation: InstanceInvitationMetadata;
			member: InstanceMemberMetadata;
			replayed?: false;
	  }
	| {
			outcome: 'replayed';
			invitation: InstanceInvitationMetadata;
			member: InstanceMemberMetadata;
			replayed: true;
	  }
	| { outcome: 'already_member'; member: InstanceMemberMetadata }
	| { outcome: 'invitation_invalid' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface ListReceivedInstanceInvitationsInput {
	/** The caller's own provider-verified email; never a request-supplied value. */
	email: string;
}

export type ListReceivedInstanceInvitationsResult = ListReceivedInstanceInvitationsStoreResult;

export interface AcceptReceivedInstanceInvitationInput {
	idempotencyKey: string;
	invitationId: string;
	/** The caller's own provider-verified email; never a request-supplied value. */
	email: string;
}

export interface RevokeInstanceInvitationInput {
	idempotencyKey: string;
	invitationId?: string;
}

/**
 * Public revoke outcomes.
 *
 * `revoked` and `replayed` both resolve the revoked invitation metadata.
 * `replayed: true` distinguishes an idempotent replay.
 */
export type RevokeInstanceInvitationResult =
	| {
			outcome: 'revoked';
			invitation: InstanceInvitationMetadata;
			replayed?: false;
	  }
	| {
			outcome: 'replayed';
			invitation: InstanceInvitationMetadata;
			replayed: true;
	  }
	| { outcome: 'forbidden' }
	| { outcome: 'invitation_invalid' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'member_suspended' }
	| { outcome: 'integrity_error' };

export interface InstanceInvitationApplicationPort {
	create(
		actor: InstanceInvitationActor,
		input: CreateInstanceInvitationInput
	): Promise<CreateInstanceInvitationResult>;
	createInstanceInvitation(
		actor: InstanceInvitationActor,
		input: CreateInstanceInvitationInput
	): Promise<CreateInstanceInvitationResult>;
	list(
		actor: InstanceInvitationActor,
		query?: ListInstanceInvitationsInput
	): Promise<ListInstanceInvitationsResult>;
	listInstanceInvitations(
		actor: InstanceInvitationActor,
		query?: ListInstanceInvitationsInput
	): Promise<ListInstanceInvitationsResult>;
	/** Pending invitations addressed to the caller's verified email. */
	listReceived(
		actor: InstanceInvitationActor,
		input: ListReceivedInstanceInvitationsInput
	): Promise<ListReceivedInstanceInvitationsResult>;
	/** Accepts one received invitation by id, without the emailed link. */
	acceptReceived(
		actor: InstanceInvitationActor,
		input: AcceptReceivedInstanceInvitationInput
	): Promise<AcceptInstanceInvitationResult>;
	revoke(
		actor: InstanceInvitationActor,
		invitationIdOrInput: string | (RevokeInstanceInvitationInput & { invitationId: string }),
		maybeInput?: RevokeInstanceInvitationInput
	): Promise<RevokeInstanceInvitationResult>;
	revokeInstanceInvitation(
		actor: InstanceInvitationActor,
		invitationIdOrInput: string | (RevokeInstanceInvitationInput & { invitationId: string }),
		maybeInput?: RevokeInstanceInvitationInput
	): Promise<RevokeInstanceInvitationResult>;
	/**
	 * Settles a held outbox row after the console note. Only the create handler
	 * calls it, right after the note, for an invitation it just created or
	 * replayed; it needs no actor because it never changes the invitation, only
	 * whether the drain still has to deliver the note.
	 */
	settleDelivery(
		invitationId: string,
		handoff: InstanceInvitationDeliveryHandoff
	): Promise<SettleInstanceInvitationDeliveryStoreResult>;
}

export type InstanceInvitationServicePort = InstanceInvitationApplicationPort;

export class InvalidInstanceInvitationRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidInstanceInvitationRequestError';
	}
}

export class InstanceInvitationCollisionExhaustedError extends Error {
	constructor(
		message: string = 'Instance invitation credential generation exhausted its collision retries'
	) {
		super(message);
		this.name = 'InstanceInvitationCollisionExhaustedError';
	}
}

export interface InstanceInvitationApplicationDependencies {
	readonly store: InstanceStore;
	readonly payloadSealer: InstanceInvitationDeliveryPayloadSealer;
	readonly displaySealer?: InstanceDisplayPayloadSealer;
	readonly now?: () => Date;
	readonly newId?: UuidV7Generator;
	readonly newDeliveryId?: UuidV7Generator;
	readonly issueToken?: () => Promise<IssuedInstanceInvitationToken>;
}

/**
 * Pure application service coordinating zero-PII instance invitation workflows:
 *
 * - `create`: validates/normalizes email and role, computes fixed 7-day expiry,
 *   computes a keyed, zero-PII request fingerprint over email, role, and locale, mints
 *   UUIDv7/token/binding, retries up to 3 times strictly on `credential_collision`,
 *   and returns token on fresh creation or `replayed: true` on replay.
 * - `list`: validates/clamps limits and passes pagination cursor to store.
 * - `accept`: validates bearer token, normalizes authenticated principal email,
 *   hashes token and computes email binding, fingerprints canonical `tokenHash`
 *   (zero-PII), and enlists the store with authenticated caller subject.
 * - `listReceived` / `acceptReceived`: the same acceptance without the link,
 *   matching the keyed recipient lookup of the caller's verified email.
 * - `revoke`: validates target UUIDv7, fingerprints canonical `invitationId`, and
 *   marks replay state.
 */
export class InstanceInvitationApplication implements InstanceInvitationApplicationPort {
	private readonly store: InstanceStore;
	private readonly now: () => Date;
	private readonly newId: UuidV7Generator;
	private readonly newDeliveryId: UuidV7Generator;
	private readonly issueToken: () => Promise<IssuedInstanceInvitationToken>;
	private readonly payloadSealer: InstanceInvitationDeliveryPayloadSealer;
	private readonly displaySealer: InstanceDisplayPayloadSealer | null;

	constructor(storeOrDependencies: InstanceStore | InstanceInvitationApplicationDependencies) {
		if (
			'store' in storeOrDependencies &&
			typeof (storeOrDependencies as InstanceInvitationApplicationDependencies).store ===
				'object' &&
			(storeOrDependencies as InstanceInvitationApplicationDependencies).store !== null
		) {
			const deps: InstanceInvitationApplicationDependencies =
				storeOrDependencies as InstanceInvitationApplicationDependencies;
			this.store = deps.store;
			this.payloadSealer = deps.payloadSealer;
			this.displaySealer = deps.displaySealer ?? null;
			this.now = deps.now ?? ((): Date => new Date());
			this.newId = deps.newId ?? newUuidV7;
			this.newDeliveryId = deps.newDeliveryId ?? newUuidV7;
			this.issueToken = deps.issueToken ?? issueInstanceInvitationToken;
		} else {
			throw new Error('Instance invitation delivery encryption is required');
		}
	}

	async create(
		actor: InstanceInvitationActor,
		input: CreateInstanceInvitationInput
	): Promise<CreateInstanceInvitationResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const normalizedEmail: string = normalizeEmail(input.email);
		const normalizedRole: InstanceMemberRole = normalizeRole(input.role);
		const locale: InstanceInvitationDeliveryLocale = input.locale ?? 'ja';

		const now: Date = this.now();
		const createdAt: string = now.toISOString();
		const expiresAt: string = computeExpiresAt(now, input.expiresAt);
		const deliveryHoldMs: number = assertDeliveryHoldMs(input.deliveryHoldMs);
		const deliveryAvailableAt: string | undefined =
			deliveryHoldMs > 0 ? new Date(now.valueOf() + deliveryHoldMs).toISOString() : undefined;

		// Keyed fingerprint binds every delivery-affecting field without making the
		// invited mailbox guessable from a stored unsalted hash. The previous-key
		// candidate preserves exact replays during the documented rotation window.
		const requestFingerprints: InstanceInvitationRequestFingerprints =
			await this.payloadSealer.fingerprintRequest({
				email: normalizedEmail,
				role: normalizedRole,
				locale
			});
		// Keyed, so the stored lookup does not let the database alone test
		// candidate addresses; it lets the verified recipient accept without
		// the emailed link.
		const recipientLookups: InstanceInvitationRecipientLookups =
			await this.payloadSealer.recipientLookups(normalizedEmail);

		for (let attempt: number = 0; attempt < MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
			const invitationId: string = this.newId();
			if (!isInstanceInvitationId(invitationId)) {
				throw new Error('Generated invitation id is not a canonical UUIDv7');
			}

			const issued: IssuedInstanceInvitationToken = await this.issueToken();
			const deliveryId: string = this.newDeliveryId();
			if (!isInstanceInvitationId(deliveryId)) {
				throw new Error('Generated invitation delivery id is not a canonical UUIDv7');
			}
			const emailBinding: string = await computeInstanceInvitationEmailBinding(
				issued.token,
				normalizedEmail
			);
			const sealed = await this.payloadSealer.seal(
				{ email: normalizedEmail, token: issued.token },
				{ invitationId, deliveryId }
			);
			const sealedDisplay =
				this.displaySealer === null
					? null
					: await this.displaySealer.sealInvitationTarget({ email: normalizedEmail }, invitationId);

			const command: CreateInstanceInvitationCommand = {
				actor: commandActor,
				idempotencyKey,
				requestFingerprint: requestFingerprints.active,
				previousRequestFingerprint: requestFingerprints.previous,
				invitationId,
				role: normalizedRole,
				tokenHash: issued.tokenHash,
				emailBinding,
				deliveryId,
				deliveryLocale: locale,
				sealedDeliveryPayload: sealed.sealedPayload,
				deliverySealingKeyId: sealed.sealingKeyId,
				sealedDeliveryPayloadSha256: sealed.sealedPayloadSha256,
				createdAt,
				expiresAt,
				recipientLookup: recipientLookups.active,
				...(deliveryAvailableAt === undefined ? {} : { deliveryAvailableAt }),
				...(sealedDisplay === null
					? {}
					: {
							sealedDisplayPayload: sealedDisplay.sealedPayload,
							displaySealingKeyId: sealedDisplay.sealingKeyId
						})
			};

			const result: CreateInstanceInvitationStoreResult =
				await this.store.createInstanceInvitation(command);

			switch (result.outcome) {
				case 'created':
					return {
						outcome: 'created',
						invitation: result.invitation,
						replayed: false
					};
				case 'replayed':
					return {
						outcome: 'replayed',
						invitation: result.invitation,
						replayed: true
					};
				case 'credential_collision':
					continue;
				default:
					return result;
			}
		}

		throw new InstanceInvitationCollisionExhaustedError();
	}

	async createInstanceInvitation(
		actor: InstanceInvitationActor,
		input: CreateInstanceInvitationInput
	): Promise<CreateInstanceInvitationResult> {
		return this.create(actor, input);
	}

	async list(
		actor: InstanceInvitationActor,
		query: ListInstanceInvitationsInput = {}
	): Promise<ListInstanceInvitationsResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const limit: number =
			typeof query?.limit === 'number'
				? boundInstanceInvitationListLimit(query.limit)
				: DEFAULT_INSTANCE_INVITATION_LIST_LIMIT;
		const cursor: string | null = query?.cursor ?? null;

		const view: InstanceInvitationListView | undefined = normalizeListView(query?.view);
		const listQuery: InstanceInvitationListQuery = {
			cursor,
			limit,
			...(view === undefined ? {} : { view })
		};

		return await this.store.listInstanceInvitations(commandActor, listQuery);
	}

	async listInstanceInvitations(
		actor: InstanceInvitationActor,
		query: ListInstanceInvitationsInput = {}
	): Promise<ListInstanceInvitationsResult> {
		return this.list(actor, query);
	}

	async listReceived(
		actor: InstanceInvitationActor,
		input: ListReceivedInstanceInvitationsInput
	): Promise<ListReceivedInstanceInvitationsResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const normalizedEmail: string = normalizeEmail(input.email);
		const lookups: InstanceInvitationRecipientLookups =
			await this.payloadSealer.recipientLookups(normalizedEmail);
		return await this.store.listReceivedInstanceInvitations({
			actor: commandActor,
			recipientLookup: lookups.active,
			...(lookups.previous === undefined ? {} : { previousRecipientLookup: lookups.previous }),
			now: this.now().toISOString(),
			limit: MAX_RECEIVED_INSTANCE_INVITATIONS
		});
	}

	async acceptReceived(
		actor: InstanceInvitationActor,
		input: AcceptReceivedInstanceInvitationInput
	): Promise<AcceptInstanceInvitationResult> {
		const commandActor: InstanceActor = assertActor(actor);
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const invitationId: string = assertInvitationId(input.invitationId);
		const normalizedEmail: string = normalizeEmail(input.email);
		const lookups: InstanceInvitationRecipientLookups =
			await this.payloadSealer.recipientLookups(normalizedEmail);
		// Distinct from the link's `{ tokenHash }` fingerprint, so one
		// Idempotency-Key can never replay one accept form as the other.
		const requestFingerprint: string = await sha256Hex(
			canonicalJson({ invitationId, proof: 'verified_email' })
		);
		const command: AcceptInstanceInvitationByRecipientCommand = {
			actor: commandActor,
			idempotencyKey,
			requestFingerprint,
			invitationId,
			recipientLookup: lookups.active,
			...(lookups.previous === undefined ? {} : { previousRecipientLookup: lookups.previous }),
			acceptedAt: this.now().toISOString()
		};
		return publicAcceptResult(await this.store.acceptInstanceInvitation(command));
	}

	async revoke(
		actor: InstanceInvitationActor,
		invitationIdOrInput: string | (RevokeInstanceInvitationInput & { invitationId: string }),
		maybeInput?: RevokeInstanceInvitationInput
	): Promise<RevokeInstanceInvitationResult> {
		const commandActor: InstanceActor = assertActor(actor);

		let invitationId: string;
		let input: RevokeInstanceInvitationInput;

		if (typeof invitationIdOrInput === 'string') {
			invitationId = invitationIdOrInput;
			input = maybeInput ?? { idempotencyKey: '' };
		} else if (
			invitationIdOrInput &&
			typeof invitationIdOrInput === 'object' &&
			'invitationId' in invitationIdOrInput
		) {
			invitationId = invitationIdOrInput.invitationId;
			input = invitationIdOrInput;
		} else {
			throw new InvalidInstanceInvitationRequestError('Invalid instance invitation identifier.');
		}

		assertInvitationId(invitationId);
		const idempotencyKey: string = assertIdempotencyKey(input.idempotencyKey);
		const requestFingerprint: string = await sha256Hex(canonicalJson({ invitationId }));
		const revokedAt: string = this.now().toISOString();

		const command: RevokeInstanceInvitationCommand = {
			actor: commandActor,
			idempotencyKey,
			requestFingerprint,
			invitationId,
			revokedAt
		};

		const result: RevokeInstanceInvitationStoreResult =
			await this.store.revokeInstanceInvitation(command);

		switch (result.outcome) {
			case 'revoked':
				return {
					outcome: 'revoked',
					invitation: result.invitation,
					replayed: false
				};
			case 'replayed':
				return {
					outcome: 'replayed',
					invitation: result.invitation,
					replayed: true
				};
			default:
				return result;
		}
	}

	async revokeInstanceInvitation(
		actor: InstanceInvitationActor,
		invitationIdOrInput: string | (RevokeInstanceInvitationInput & { invitationId: string }),
		maybeInput?: RevokeInstanceInvitationInput
	): Promise<RevokeInstanceInvitationResult> {
		return this.revoke(actor, invitationIdOrInput, maybeInput);
	}

	async settleDelivery(
		invitationId: string,
		handoff: InstanceInvitationDeliveryHandoff
	): Promise<SettleInstanceInvitationDeliveryStoreResult> {
		if (!isInstanceInvitationId(invitationId)) {
			throw new InvalidInstanceInvitationRequestError('Invitation id is invalid');
		}
		if (handoff !== 'console' && handoff !== 'self') {
			throw new InvalidInstanceInvitationRequestError('Delivery handoff is invalid');
		}
		return await this.store.settleInstanceInvitationDelivery({
			invitationId,
			handoff,
			settledAt: this.now().toISOString()
		});
	}
}

export { InstanceInvitationApplication as InstanceInvitationService };

/** A hold is a whole number of milliseconds up to ten minutes. */
const MAX_DELIVERY_HOLD_MS: number = 10 * 60 * 1000;

function assertDeliveryHoldMs(value: number | undefined): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELIVERY_HOLD_MS) {
		throw new InvalidInstanceInvitationRequestError('Delivery hold is invalid');
	}
	return value;
}

function publicAcceptResult(
	result: AcceptInstanceInvitationStoreResult
): AcceptInstanceInvitationResult {
	switch (result.outcome) {
		case 'accepted':
			return {
				outcome: 'accepted',
				invitation: result.invitation,
				member: result.member,
				replayed: false
			};
		case 'replayed':
			return {
				outcome: 'replayed',
				invitation: result.invitation,
				member: result.member,
				replayed: true
			};
		default:
			return result;
	}
}

function assertActor(actor: InstanceInvitationActor): InstanceActor {
	if (!actor || typeof actor.id !== 'string' || actor.id.length < 1 || actor.id.length > 200) {
		throw new InvalidInstanceInvitationRequestError('Invalid actor user identifier.');
	}
	if (actor.type !== undefined && actor.type !== 'user') {
		throw new InvalidInstanceInvitationRequestError('Invalid actor user identifier.');
	}
	return { type: 'user', id: actor.id };
}

function assertIdempotencyKey(key: unknown): string {
	if (typeof key !== 'string' || !isInstanceIdempotencyKey(key)) {
		throw new InvalidInstanceInvitationRequestError(
			'Idempotency-Key must contain visible ASCII characters only.'
		);
	}
	return key;
}

function normalizeEmail(email: unknown): string {
	if (typeof email !== 'string') {
		throw new InvalidInstanceInvitationRequestError('Invalid instance invitation email');
	}
	try {
		return normalizeInstanceInvitationEmail(email);
	} catch (error: unknown) {
		const message: string =
			error instanceof Error ? error.message : 'Invalid instance invitation email';
		throw new InvalidInstanceInvitationRequestError(message);
	}
}

function normalizeRole(role: unknown): InstanceMemberRole {
	if (typeof role !== 'string') {
		throw new InvalidInstanceInvitationRequestError('Invalid instance member role');
	}
	const trimmed: string = role.trim().toLowerCase();
	if (!isInstanceMemberRole(trimmed)) {
		throw new InvalidInstanceInvitationRequestError('Invalid instance member role');
	}
	return trimmed;
}

function computeExpiresAt(now: Date, requestedExpiresAt?: string | null): string {
	try {
		return resolveInstanceInvitationExpiresAt(now, requestedExpiresAt);
	} catch (error: unknown) {
		const message: string =
			error instanceof Error ? error.message : 'Invalid instance invitation expiry';
		throw new InvalidInstanceInvitationRequestError(message);
	}
}

function assertInvitationId(id: unknown): string {
	if (typeof id !== 'string' || !isInstanceInvitationId(id)) {
		throw new InvalidInstanceInvitationRequestError('Invalid instance invitation identifier.');
	}
	return id;
}

function normalizeListView(view: unknown): InstanceInvitationListView | undefined {
	if (view === undefined) return undefined;
	if (!isInstanceInvitationListView(view)) {
		throw new InvalidInstanceInvitationRequestError('Invalid instance invitation list view.');
	}
	return view;
}
