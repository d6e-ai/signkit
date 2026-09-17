import {
	boundInstanceInvitationDeliveryClaimLimit,
	MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
	type ClaimedInstanceInvitationDelivery,
	type InstanceInvitationDeliveryStore
} from '$lib/ports/instance-invitation-delivery-store';
import {
	mailProviderReceiptId,
	MailDeliveryError,
	type MailMessage,
	type MailSendReceipt,
	type MailSender
} from '$lib/ports/mail-sender';
import {
	computeInstanceInvitationEmailBinding,
	hashInstanceInvitationToken
} from '$lib/security/instance-invitation';
import type { InstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import { sha256Hex } from '$lib/security/sealing-keyring';
import { newOpaqueToken, type OpaqueTokenGenerator } from '$lib/security/opaque-token';
import { sanitizeDeliveryErrorCode } from '$lib/ports/delivery-outbox-store';
import { renderInstanceInvitationMail } from './instance-invitation-email';

export const INSTANCE_INVITATION_DELIVERY_LEASE_MS: number = 5 * 60 * 1000;
export const INSTANCE_INVITATION_DELIVERY_MAX_ATTEMPTS: number =
	MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS;
const RETRY_BASE_MS: number = 30_000;
const RETRY_MAX_MS: number = 6 * 60 * 60 * 1000;
const CONCURRENCY: number = 5;

export interface InstanceInvitationDeliverySenderConfig {
	fromEmail: string;
	fromName: string;
}

export class InvalidInstanceInvitationDeliveryConfigError extends Error {
	constructor() {
		super('Instance invitation delivery configuration is invalid');
		this.name = 'InvalidInstanceInvitationDeliveryConfigError';
	}
}

export type InstanceInvitationDeliveryItemOutcome =
	| { deliveryId: string; outcome: 'delivered' | 'stale' }
	| {
			deliveryId: string;
			outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
			errorCode: string;
	  };

export interface InstanceInvitationDeliveryBatchResult {
	claimed: number;
	delivered: number;
	retryableFailed: number;
	permanentlyFailed: number;
	integrityFailed: number;
	stale: number;
	outcomes: readonly InstanceInvitationDeliveryItemOutcome[];
}

export class InstanceInvitationDeliveryService {
	readonly #store: InstanceInvitationDeliveryStore;
	readonly #sealer: InstanceInvitationDeliveryPayloadSealer;
	readonly #mail: MailSender;
	readonly #origin: string;
	readonly #sender: InstanceInvitationDeliverySenderConfig;
	readonly #now: () => Date;
	readonly #newClaimToken: OpaqueTokenGenerator;

	constructor(
		store: InstanceInvitationDeliveryStore,
		sealer: InstanceInvitationDeliveryPayloadSealer,
		mail: MailSender,
		publicOrigin: string,
		sender: InstanceInvitationDeliverySenderConfig,
		now: () => Date = (): Date => new Date(),
		newClaimToken: OpaqueTokenGenerator = newOpaqueToken
	) {
		this.#store = store;
		this.#sealer = sealer;
		this.#mail = mail;
		this.#origin = assertPublicHttpsOrigin(publicOrigin);
		this.#sender = assertSenderConfig(sender);
		this.#now = now;
		this.#newClaimToken = newClaimToken;
	}

	async deliverPending(limit: number = 25): Promise<InstanceInvitationDeliveryBatchResult> {
		const now: Date = this.#now();
		const claimToken: string = this.#newClaimToken();
		const claims: readonly ClaimedInstanceInvitationDelivery[] = await this.#store.claimPending({
			claimToken,
			claimedAt: now.toISOString(),
			staleBefore: new Date(now.valueOf() - INSTANCE_INVITATION_DELIVERY_LEASE_MS).toISOString(),
			limit: boundInstanceInvitationDeliveryClaimLimit(limit)
		});
		const outcomes: InstanceInvitationDeliveryItemOutcome[] = [];
		for (let offset: number = 0; offset < claims.length; offset += CONCURRENCY) {
			const chunk: readonly ClaimedInstanceInvitationDelivery[] = claims.slice(
				offset,
				offset + CONCURRENCY
			);
			const settled = await Promise.allSettled(
				chunk.map((claim: ClaimedInstanceInvitationDelivery) =>
					this.#deliver(claim, claimToken, now)
				)
			);
			settled.forEach((result, index: number): void => {
				outcomes.push(
					result.status === 'fulfilled'
						? result.value
						: {
								deliveryId: chunk[index].deliveryId,
								outcome: 'retryable_failed',
								errorCode: 'delivery_store_unavailable'
							}
				);
			});
		}
		return summarize(claims.length, outcomes);
	}

	async #deliver(
		claim: ClaimedInstanceInvitationDelivery,
		claimToken: string,
		now: Date
	): Promise<InstanceInvitationDeliveryItemOutcome> {
		const refreshed: ClaimedInstanceInvitationDelivery | null = await this.#store.readClaimed({
			deliveryId: claim.deliveryId,
			claimToken
		});
		if (refreshed === null) return { deliveryId: claim.deliveryId, outcome: 'stale' };
		claim = refreshed;
		if (claim.invitationStatus !== 'pending' || Date.parse(claim.expiresAt) <= now.valueOf()) {
			return this.#fail(claim, claimToken, 'invitation_not_active', false, now, 'integrity_failed');
		}
		if (claim.sealedPayload === null) {
			return this.#fail(claim, claimToken, 'ciphertext_missing', false, now, 'integrity_failed');
		}
		if (
			(await sha256Hex(new TextEncoder().encode(claim.sealedPayload))) !== claim.sealedPayloadSha256
		) {
			return this.#fail(
				claim,
				claimToken,
				'ciphertext_digest_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}
		if (!(await this.#sealer.isKnownSealingKeyId(claim.sealingKeyId))) {
			return this.#fail(claim, claimToken, 'sealing_key_mismatch', true, now, 'retryable_failed');
		}

		let payload;
		try {
			payload = await this.#sealer.open(
				claim.sealedPayload,
				{ invitationId: claim.invitationId, deliveryId: claim.deliveryId },
				claim.sealingKeyId
			);
		} catch {
			return this.#fail(claim, claimToken, 'payload_open_failed', false, now, 'integrity_failed');
		}
		if (
			(await hashInstanceInvitationToken(payload.token)) !== claim.tokenHash ||
			(await computeInstanceInvitationEmailBinding(payload.token, payload.email)) !==
				claim.emailBinding
		) {
			return this.#fail(
				claim,
				claimToken,
				'payload_binding_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}

		const settingsUrl: string = `${this.#origin}/${claim.locale}/settings`;
		const copy = renderInstanceInvitationMail(
			claim.locale,
			claim.role,
			settingsUrl,
			payload.token,
			claim.expiresAt
		);
		const message: MailMessage = {
			to: payload.email,
			from: { email: this.#sender.fromEmail, name: this.#sender.fromName },
			subject: copy.subject,
			text: copy.text,
			html: copy.html,
			deliveryKey: claim.deliveryId
		};
		let receipt: MailSendReceipt;
		try {
			receipt = await this.#mail.send(message);
		} catch (error: unknown) {
			if (error instanceof MailDeliveryError) {
				return this.#fail(
					claim,
					claimToken,
					error.code,
					error.retryable,
					now,
					error.retryable ? 'retryable_failed' : 'permanently_failed'
				);
			}
			return this.#fail(claim, claimToken, 'mail_delivery_failed', true, now, 'retryable_failed');
		}
		const providerMessageId: string | null = mailProviderReceiptId(receipt);
		if (providerMessageId === null) {
			return this.#fail(claim, claimToken, 'mail_receipt_invalid', true, now, 'retryable_failed');
		}
		const completed = await this.#store.complete({
			deliveryId: claim.deliveryId,
			claimToken,
			deliveredAt: now.toISOString(),
			providerMessageId
		});
		return completed.outcome === 'completed'
			? { deliveryId: claim.deliveryId, outcome: 'delivered' }
			: { deliveryId: claim.deliveryId, outcome: 'stale' };
	}

	async #fail(
		claim: ClaimedInstanceInvitationDelivery,
		claimToken: string,
		code: string,
		retryable: boolean,
		now: Date,
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed'
	): Promise<InstanceInvitationDeliveryItemOutcome> {
		const exhausted: boolean =
			retryable && claim.attempts >= INSTANCE_INVITATION_DELIVERY_MAX_ATTEMPTS;
		const willRetry: boolean = retryable && !exhausted;
		const errorCode: string = sanitizeDeliveryErrorCode(
			exhausted ? 'delivery_attempts_exhausted' : code
		);
		const failed = await this.#store.fail({
			deliveryId: claim.deliveryId,
			claimToken,
			errorCode,
			retryable: willRetry,
			nextAvailableAt: willRetry ? retryAt(now, claim.attempts) : now.toISOString(),
			failedAt: now.toISOString()
		});
		if (failed.outcome === 'stale') return { deliveryId: claim.deliveryId, outcome: 'stale' };
		return {
			deliveryId: claim.deliveryId,
			outcome: exhausted ? 'permanently_failed' : outcome,
			errorCode
		};
	}
}

function retryAt(now: Date, attempts: number): string {
	const exponent: number = Math.min(Math.max(1, attempts) - 1, 10);
	return new Date(
		now.valueOf() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent)
	).toISOString();
}

function assertPublicHttpsOrigin(origin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new InvalidInstanceInvitationDeliveryConfigError();
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.pathname !== '/' ||
		parsed.search !== '' ||
		parsed.hash !== ''
	) {
		throw new InvalidInstanceInvitationDeliveryConfigError();
	}
	return parsed.origin;
}

function assertSenderConfig(
	sender: InstanceInvitationDeliverySenderConfig
): InstanceInvitationDeliverySenderConfig {
	if (
		!isValidMailbox(sender.fromEmail) ||
		sender.fromName.length === 0 ||
		sender.fromName.length > 200 ||
		hasControlCharacters(sender.fromName)
	) {
		throw new InvalidInstanceInvitationDeliveryConfigError();
	}
	return sender;
}

function isValidMailbox(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 320 &&
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
		!hasControlCharacters(value)
	);
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((character: string): boolean => {
		const codePoint: number = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

function summarize(
	claimed: number,
	outcomes: readonly InstanceInvitationDeliveryItemOutcome[]
): InstanceInvitationDeliveryBatchResult {
	return {
		claimed,
		delivered: outcomes.filter((item) => item.outcome === 'delivered').length,
		retryableFailed: outcomes.filter((item) => item.outcome === 'retryable_failed').length,
		permanentlyFailed: outcomes.filter((item) => item.outcome === 'permanently_failed').length,
		integrityFailed: outcomes.filter((item) => item.outcome === 'integrity_failed').length,
		stale: outcomes.filter((item) => item.outcome === 'stale').length,
		outcomes
	};
}
