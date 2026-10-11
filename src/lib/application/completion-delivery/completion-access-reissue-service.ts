import { hashAuditEventV3 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	CompletionAccessReissueArtifactVerification,
	CompletionAccessReissueArtifactVerifier
} from './completion-access-reissue-artifact-verifier';
import type {
	CompletionAccessReissuePreparationOutcome,
	CompletionAccessReissueStore,
	ExpectedPredecessorGeneration,
	PublishCompletionAccessReissueCommand,
	PublishCompletionAccessReissueOutcome,
	PublishedCompletionAccessReissue,
	ReissueCommandKey
} from '$lib/ports/completion-access-reissue';
import type { CurrentCompletionDeliveryRow } from '$lib/ports/completion-access-reissue-row';
import {
	computeCompletionAccessExpiry,
	issueCompletionToken
} from '$lib/security/completion-token';
import type {
	CompletionTokenSealContext,
	CompletionTokenSealer,
	SealedCompletionToken
} from '$lib/security/completion-token-sealer';

/**
 * Bounds the bounded-retry loop below. Exhausting it on a genuine artifact
 * mismatch is not a transient failure, but re-trying a few times absorbs the
 * ordinary audit-head or `retryable_error` object-storage races this process
 * can resolve by itself rather than forcing the caller to resubmit.
 */
const MAX_RETRY_ATTEMPTS: number = 3;

export interface CompletionAccessReissueActor {
	type: 'user' | 'agent';
	id: string;
}

export interface ReissueCompletionAccessInput {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	expectedDeliveryId: string;
	expectedAttempts: number;
	expectedFailedAt: string;
	expectedErrorCode: string;
}

export type NotEligibleCompletionAccessReissueReason = NonNullable<
	CompletionAccessReissuePreparationOutcome['notEligibleReason']
>;

export type ReissueCompletionAccessResult =
	| { outcome: 'published' | 'replayed'; result: PublishedCompletionAccessReissue }
	| { outcome: 'not_found' }
	| { outcome: 'not_eligible'; reason: NotEligibleCompletionAccessReissueReason }
	| { outcome: 'stale_generation' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'artifact_unavailable' }
	| { outcome: 'integrity_error' };

export interface CompletionAccessReissueApplicationPort {
	/** `null` when no envelope with this ID exists; see {@link CompletionAccessReissueStore.listCurrentDeliveries}. */
	listCurrentDeliveries(
		envelopeId: string
	): Promise<readonly CurrentCompletionDeliveryRow[] | null>;
	reissue(
		actor: CompletionAccessReissueActor,
		input: ReissueCompletionAccessInput
	): Promise<ReissueCompletionAccessResult>;
}

/**
 * Grants a fresh, bounded-expiry completion access delivery as a chained
 * successor to a specific exhausted, revoked, scrubbed generation -- never
 * reviving it. The predecessor's own status/attempts/error/revocation/expiry
 * stay exactly as the exhausting failure wrote them; this only appends a new
 * row the store chains to it. The completion manifest and PDF are
 * independently re-verified against actual object storage bytes (never the
 * database pointer alone) immediately before each publish attempt, and the
 * exact digests observed are carried into the store's write-time recheck so
 * a repair that replaces either artifact mid-flight is caught rather than
 * granting access to evidence this process never actually verified.
 */
export class CompletionAccessReissueService implements CompletionAccessReissueApplicationPort {
	readonly #store: CompletionAccessReissueStore;
	readonly #verifier: CompletionAccessReissueArtifactVerifier;
	readonly #sealer: CompletionTokenSealer;
	readonly #now: () => Date;
	readonly #newId: UuidV7Generator;

	constructor(
		store: CompletionAccessReissueStore,
		verifier: CompletionAccessReissueArtifactVerifier,
		sealer: CompletionTokenSealer,
		now: () => Date = (): Date => new Date(),
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#verifier = verifier;
		this.#sealer = sealer;
		this.#now = now;
		this.#newId = newId;
	}

	async listCurrentDeliveries(
		envelopeId: string
	): Promise<readonly CurrentCompletionDeliveryRow[] | null> {
		return await this.#store.listCurrentDeliveries(envelopeId);
	}

	async reissue(
		actor: CompletionAccessReissueActor,
		input: ReissueCompletionAccessInput
	): Promise<ReissueCompletionAccessResult> {
		const requestHash: string = await sha256Hex(
			JSON.stringify({
				envelopeId: input.envelopeId,
				recipientId: input.recipientId,
				expectedDeliveryId: input.expectedDeliveryId,
				expectedAttempts: input.expectedAttempts,
				expectedFailedAt: input.expectedFailedAt,
				expectedErrorCode: input.expectedErrorCode
			})
		);
		const key: ReissueCommandKey = {
			envelopeId: input.envelopeId,
			recipientId: input.recipientId,
			predecessorDeliveryId: input.expectedDeliveryId,
			actorType: actor.type,
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestHash
		};
		const expected: ExpectedPredecessorGeneration = {
			expectedAttempts: input.expectedAttempts,
			expectedFailedAt: input.expectedFailedAt,
			expectedErrorCode: input.expectedErrorCode
		};

		// Replay and eligibility are resolved before any object-storage IO or
		// mutable-state write: a clearly stale or ineligible request never pays
		// for a manifest/PDF re-verification it cannot use.
		for (let attempt: number = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
			const preparation: CompletionAccessReissuePreparationOutcome =
				await this.#store.prepareReissue(key, expected);
			if (preparation.outcome !== 'ready' || preparation.auditHead === undefined) {
				return fromPreparation(preparation);
			}

			const verification: CompletionAccessReissueArtifactVerification = await this.#verifier.verify(
				input.envelopeId
			);
			if (verification.outcome === 'unpublished') return { outcome: 'artifact_unavailable' };
			if (verification.outcome !== 'verified') {
				if (verification.outcome === 'retryable_error' && attempt + 1 < MAX_RETRY_ATTEMPTS) {
					continue;
				}
				return { outcome: 'integrity_error' };
			}

			const newDeliveryId: string = this.#newId();
			const issued = await issueCompletionToken();
			const context: CompletionTokenSealContext = {
				envelopeId: input.envelopeId,
				recipientId: input.recipientId,
				deliveryId: newDeliveryId
			};
			const sealed: SealedCompletionToken = await this.#sealer.seal(issued.token, context);

			const reissuedAt: string = this.#now().toISOString();
			const newAccessExpiresAt: string = computeCompletionAccessExpiry(this.#now());

			const auditEventId: string = this.#newId();
			const auditPayloadJson: string = JSON.stringify({
				recipientId: input.recipientId,
				predecessorDeliveryId: input.expectedDeliveryId,
				deliveryId: newDeliveryId,
				reissuedAt
			});
			const auditEventHash: string = await hashAuditEventV3(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'recipient.completion_access_reissued',
					actorType: actor.type,
					actorId: actor.id,
					occurredAt: reissuedAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ envelopeId: input.envelopeId }
			);

			const command: PublishCompletionAccessReissueCommand = {
				...key,
				...expected,
				newDeliveryId,
				newTokenHash: issued.tokenHash,
				newAccessExpiresAt,
				sealedToken: sealed.sealedToken,
				sealingKeyId: sealed.sealingKeyId,
				sealedTokenSha256: sealed.sealedTokenSha256,
				reissuedAt,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson,
				expectedJsonSha256: verification.pointer.jsonSha256,
				expectedMarkdownSha256: verification.pointer.markdownSha256,
				expectedPdfSha256: verification.pointer.pdfSha256
			};

			const published: PublishCompletionAccessReissueOutcome =
				await this.#store.publishReissue(command);
			if (published.outcome === 'integrity_error' && attempt + 1 < MAX_RETRY_ATTEMPTS) continue;
			return fromPublish(published);
		}

		return { outcome: 'integrity_error' };
	}
}

function fromPreparation(
	preparation: CompletionAccessReissuePreparationOutcome
): ReissueCompletionAccessResult {
	switch (preparation.outcome) {
		case 'ready':
			return { outcome: 'integrity_error' };
		case 'replayed':
			return preparation.result === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'replayed', result: preparation.result };
		case 'not_found':
			return { outcome: 'not_found' };
		case 'not_eligible':
			return preparation.notEligibleReason === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'not_eligible', reason: preparation.notEligibleReason };
		case 'stale_generation':
			return { outcome: 'stale_generation' };
		case 'idempotency_conflict':
			return { outcome: 'idempotency_conflict' };
		case 'integrity_error':
			return { outcome: 'integrity_error' };
	}
}

function fromPublish(
	published: PublishCompletionAccessReissueOutcome
): ReissueCompletionAccessResult {
	switch (published.outcome) {
		case 'published':
			return published.result === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'published', result: published.result };
		case 'replayed':
			return published.result === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'replayed', result: published.result };
		case 'not_found':
			return { outcome: 'not_found' };
		case 'not_eligible':
			return published.notEligibleReason === undefined
				? { outcome: 'integrity_error' }
				: { outcome: 'not_eligible', reason: published.notEligibleReason };
		case 'stale_generation':
			return { outcome: 'stale_generation' };
		case 'idempotency_conflict':
			return { outcome: 'idempotency_conflict' };
		case 'integrity_error':
			return { outcome: 'integrity_error' };
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
