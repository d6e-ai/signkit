import type { EnvelopeStatus, RecipientStatus } from '$lib/domain/envelope';
import {
	boundInvitationClaimLimit,
	MAX_INVITATION_CLAIM_BATCH,
	sanitizeDeliveryErrorCode,
	type ClaimedInvitationDelivery,
	type CompleteInvitationDeliveryResult,
	type DeliveryOutboxStore,
	type FailInvitationDeliveryResult
} from '$lib/ports/delivery-outbox-store';
import {
	mailProviderReceiptId,
	MailDeliveryError,
	type MailMessage,
	type MailSendReceipt,
	type MailSender
} from '$lib/ports/mail-sender';
import type { CapabilitySealContext } from '$lib/security/delivery-capability';
import { newOpaqueToken, type OpaqueTokenGenerator } from '$lib/security/opaque-token';
import { hashRecipientCapability, recipientSigningPath } from '$lib/security/recipient-capability';

export const INVITATION_CLAIM_LEASE_MS: number = 5 * 60 * 1000;
export const INVITATION_RETRY_BASE_DELAY_MS: number = 30_000;
export const INVITATION_RETRY_MAX_DELAY_MS: number = 6 * 60 * 60 * 1000;
export const MAX_INVITATION_DELIVERY_ATTEMPTS: number = 10;
const INVITATION_DELIVERY_CONCURRENCY: number = 5;
const ACTIVE_ENVELOPE_STATUSES = new Set<EnvelopeStatus>(['sent', 'in_progress']);
const ACTIVE_RECIPIENT_STATUSES = new Set<RecipientStatus>(['pending']);

export interface InvitationSenderConfig {
	fromEmail: string;
	fromName: string;
}

export interface RecipientCapabilityOpener {
	currentSealingKeyId(): Promise<string>;
	open(sealedCapability: string, context: CapabilitySealContext): Promise<string>;
}

export type InvitationDeliveryItemOutcome =
	| { deliveryId: string; outcome: 'delivered' }
	| { deliveryId: string; outcome: 'stale' }
	| {
			deliveryId: string;
			outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
			errorCode: string;
	  };

export interface InvitationDeliveryBatchResult {
	claimed: number;
	delivered: number;
	retryableFailed: number;
	permanentlyFailed: number;
	integrityFailed: number;
	stale: number;
	outcomes: readonly InvitationDeliveryItemOutcome[];
}

export class InvalidInvitationDeliveryConfigError extends Error {
	constructor() {
		super('Invitation delivery configuration is invalid');
		this.name = 'InvalidInvitationDeliveryConfigError';
	}
}

export class InvitationDeliveryService {
	readonly #store: DeliveryOutboxStore;
	readonly #opener: RecipientCapabilityOpener;
	readonly #mail: MailSender;
	readonly #publicHttpsOrigin: string;
	readonly #sender: InvitationSenderConfig;
	readonly #now: () => Date;
	readonly #newClaimToken: OpaqueTokenGenerator;

	constructor(
		store: DeliveryOutboxStore,
		opener: RecipientCapabilityOpener,
		mail: MailSender,
		publicHttpsOrigin: string,
		sender: InvitationSenderConfig,
		now: () => Date = (): Date => new Date(),
		// A lease token is opaque unguessable material, never a row identifier:
		// 256 random bits with no embedded creation time.
		newClaimToken: OpaqueTokenGenerator = newOpaqueToken
	) {
		this.#store = store;
		this.#opener = opener;
		this.#mail = mail;
		this.#publicHttpsOrigin = assertPublicHttpsOrigin(publicHttpsOrigin);
		this.#sender = assertSenderConfig(sender);
		this.#now = now;
		this.#newClaimToken = newClaimToken;
	}

	async deliverPendingInvitations(
		limit: number = MAX_INVITATION_CLAIM_BATCH
	): Promise<InvitationDeliveryBatchResult> {
		const claimedAt: Date = this.#now();
		const claimToken: string = this.#newClaimToken();
		const claims: readonly ClaimedInvitationDelivery[] = await this.#store.claimPendingInvitations({
			claimToken,
			claimedAt: claimedAt.toISOString(),
			staleBefore: new Date(claimedAt.valueOf() - INVITATION_CLAIM_LEASE_MS).toISOString(),
			limit: boundInvitationClaimLimit(limit)
		});
		const outcomes: InvitationDeliveryItemOutcome[] = [];
		for (
			let offset: number = 0;
			offset < claims.length;
			offset += INVITATION_DELIVERY_CONCURRENCY
		) {
			const chunk: readonly ClaimedInvitationDelivery[] = claims.slice(
				offset,
				offset + INVITATION_DELIVERY_CONCURRENCY
			);
			const settled: readonly PromiseSettledResult<InvitationDeliveryItemOutcome>[] =
				await Promise.allSettled(
					chunk.map((claim: ClaimedInvitationDelivery) =>
						this.#deliverClaim(claim, claimToken, claimedAt)
					)
				);
			outcomes.push(
				...settled.map(
					(
						result: PromiseSettledResult<InvitationDeliveryItemOutcome>,
						index: number
					): InvitationDeliveryItemOutcome =>
						result.status === 'fulfilled'
							? result.value
							: {
									deliveryId: chunk[index].deliveryId,
									outcome: 'retryable_failed',
									errorCode: 'delivery_store_unavailable'
								}
				)
			);
		}
		return summarize(claims.length, outcomes);
	}

	async #deliverClaim(
		claim: ClaimedInvitationDelivery,
		claimToken: string,
		now: Date
	): Promise<InvitationDeliveryItemOutcome> {
		const refreshed: ClaimedInvitationDelivery | null = await this.#store.readClaimedInvitation({
			organizationId: claim.organizationId,
			deliveryId: claim.deliveryId,
			claimToken
		});
		if (refreshed === null) return { deliveryId: claim.deliveryId, outcome: 'stale' };
		claim = refreshed;
		const integrityCode: string | null = await this.#verifyClaim(claim, now);
		if (integrityCode !== null) {
			const retryable: boolean = integrityCode === 'sealing_key_mismatch';
			return this.#finishFailure(
				claim,
				claimToken,
				integrityCode,
				retryable,
				now,
				retryable ? 'retryable_failed' : 'integrity_failed'
			);
		}

		let token: string;
		try {
			token = await this.#opener.open(requiredSealedCapability(claim), sealContext(claim));
		} catch {
			return this.#finishFailure(
				claim,
				claimToken,
				'capability_open_failed',
				false,
				now,
				'integrity_failed'
			);
		}

		let tokenHash: string;
		try {
			tokenHash = await hashRecipientCapability(token);
		} catch {
			return this.#finishFailure(
				claim,
				claimToken,
				'capability_hash_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}
		if (tokenHash !== claim.capabilityHash) {
			return this.#finishFailure(
				claim,
				claimToken,
				'capability_hash_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}

		const message: MailMessage = invitationMessage(
			claim,
			this.#sender,
			this.#publicHttpsOrigin,
			token
		);
		let receipt: MailSendReceipt;
		try {
			receipt = await this.#mail.send(message);
		} catch (error: unknown) {
			if (error instanceof MailDeliveryError) {
				return this.#finishFailure(
					claim,
					claimToken,
					error.code,
					error.retryable,
					now,
					error.retryable ? 'retryable_failed' : 'permanently_failed'
				);
			}
			return this.#finishFailure(
				claim,
				claimToken,
				'mail_delivery_failed',
				true,
				now,
				'retryable_failed'
			);
		}

		const providerMessageId: string | null = mailProviderReceiptId(receipt);
		if (providerMessageId === null) {
			return this.#finishFailure(
				claim,
				claimToken,
				'mail_receipt_invalid',
				true,
				now,
				'retryable_failed'
			);
		}

		const completion: CompleteInvitationDeliveryResult =
			await this.#store.completeInvitationDelivery({
				organizationId: claim.organizationId,
				deliveryId: claim.deliveryId,
				claimToken,
				deliveredAt: now.toISOString(),
				providerMessageId
			});
		if (completion.outcome === 'stale') return { deliveryId: claim.deliveryId, outcome: 'stale' };
		return { deliveryId: claim.deliveryId, outcome: 'delivered' };
	}

	async #verifyClaim(claim: ClaimedInvitationDelivery, now: Date): Promise<string | null> {
		if (claim.kind !== 'recipient_invitation' || claim.status !== 'processing') {
			return 'delivery_not_eligible';
		}
		if (!ACTIVE_ENVELOPE_STATUSES.has(claim.envelopeStatus)) {
			return 'envelope_not_active';
		}
		if (!ACTIVE_RECIPIENT_STATUSES.has(claim.recipientStatus)) {
			return 'recipient_not_active';
		}
		if (!isValidMailbox(claim.recipientEmail)) return 'recipient_email_invalid';
		if (claim.capabilityRevokedAt !== null) return 'capability_revoked';
		if (!isActiveExpiry(claim.capabilityExpiresAt, now)) return 'capability_expired';
		if (claim.reservedCapabilityExpiresAt !== claim.capabilityExpiresAt) {
			return 'capability_expiry_mismatch';
		}
		if (claim.sealedCapability === null || claim.sealedCapability.length === 0) {
			return 'ciphertext_missing';
		}
		const digest: string = await sha256Hex(claim.sealedCapability);
		if (digest !== claim.sealedCapabilitySha256) return 'ciphertext_digest_mismatch';
		const currentKeyId: string = await this.#opener.currentSealingKeyId();
		if (currentKeyId !== claim.sealingKeyId) return 'sealing_key_mismatch';
		return null;
	}

	async #finishFailure(
		claim: ClaimedInvitationDelivery,
		claimToken: string,
		errorCode: string,
		retryable: boolean,
		now: Date,
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed'
	): Promise<InvitationDeliveryItemOutcome> {
		const attemptsExhausted: boolean =
			retryable && claim.attempts >= MAX_INVITATION_DELIVERY_ATTEMPTS;
		const willRetry: boolean = retryable && !attemptsExhausted;
		const safeCode: string = sanitizeDeliveryErrorCode(
			attemptsExhausted ? 'delivery_attempts_exhausted' : errorCode
		);
		const failure: FailInvitationDeliveryResult = await this.#store.failInvitationDelivery({
			organizationId: claim.organizationId,
			deliveryId: claim.deliveryId,
			claimToken,
			errorCode: safeCode,
			retryable: willRetry,
			nextAvailableAt: willRetry
				? invitationRetryAvailableAt(now, claim.attempts)
				: now.toISOString(),
			failedAt: now.toISOString()
		});
		if (failure.outcome === 'stale') return { deliveryId: claim.deliveryId, outcome: 'stale' };
		return {
			deliveryId: claim.deliveryId,
			outcome: attemptsExhausted ? 'permanently_failed' : outcome,
			errorCode: safeCode
		};
	}
}

export function invitationRetryAvailableAt(now: Date, attempts: number): string {
	const safeAttempts: number = Math.max(1, attempts);
	const exponent: number = Math.min(safeAttempts - 1, 10);
	const delayMs: number = Math.min(
		INVITATION_RETRY_MAX_DELAY_MS,
		INVITATION_RETRY_BASE_DELAY_MS * 2 ** exponent
	);
	return new Date(now.valueOf() + delayMs).toISOString();
}

function summarize(
	claimed: number,
	outcomes: readonly InvitationDeliveryItemOutcome[]
): InvitationDeliveryBatchResult {
	let delivered: number = 0;
	let retryableFailed: number = 0;
	let permanentlyFailed: number = 0;
	let integrityFailed: number = 0;
	let stale: number = 0;
	for (const item of outcomes) {
		if (item.outcome === 'delivered') delivered += 1;
		else if (item.outcome === 'retryable_failed') retryableFailed += 1;
		else if (item.outcome === 'permanently_failed') permanentlyFailed += 1;
		else if (item.outcome === 'integrity_failed') integrityFailed += 1;
		else stale += 1;
	}
	return {
		claimed,
		delivered,
		retryableFailed,
		permanentlyFailed,
		integrityFailed,
		stale,
		outcomes
	};
}

function invitationMessage(
	claim: ClaimedInvitationDelivery,
	sender: InvitationSenderConfig,
	origin: string,
	token: string
): MailMessage {
	const signingUrl: string = new URL(recipientSigningPath(token), origin).href;
	const title: string = safeDisplayText(claim.envelopeTitle);
	const name: string = safeDisplayText(claim.recipientName);
	const copy: InvitationCopy =
		claim.recipientLocale === 'ja'
			? japaneseCopy(name, title, signingUrl)
			: englishCopy(name, title, signingUrl);
	return {
		to: claim.recipientEmail,
		from: { email: sender.fromEmail, name: sender.fromName },
		subject: copy.subject,
		text: copy.text,
		html: copy.html,
		deliveryKey: `signkit-invitation-v1:${claim.organizationId}:${claim.deliveryId}`
	};
}

interface InvitationCopy {
	subject: string;
	text: string;
	html: string;
}

function englishCopy(name: string, title: string, signingUrl: string): InvitationCopy {
	const safeName: string = escapeHtml(name);
	const safeTitle: string = escapeHtml(title);
	const safeUrl: string = escapeHtml(signingUrl);
	return {
		subject: `Please review "${title}"`,
		text: [
			`Hello ${name},`,
			'',
			`You have been invited to review "${title}".`,
			'',
			'Open this link to continue:',
			signingUrl
		].join('\n'),
		html: htmlDocument(
			'en',
			`<p>Hello ${safeName},</p>` +
				`<p>You have been invited to review &quot;${safeTitle}&quot;.</p>` +
				`<p><a href="${safeUrl}">Open the agreement</a></p>`
		)
	};
}

function japaneseCopy(name: string, title: string, signingUrl: string): InvitationCopy {
	const safeName: string = escapeHtml(name);
	const safeTitle: string = escapeHtml(title);
	const safeUrl: string = escapeHtml(signingUrl);
	return {
		subject: `「${title}」の確認をお願いします`,
		text: [
			`${name} 様`,
			'',
			`「${title}」の確認依頼が届いています。`,
			'',
			'次のリンクを開いて手続きを続けてください。',
			signingUrl
		].join('\n'),
		html: htmlDocument(
			'ja',
			`<p>${safeName} 様</p>` +
				`<p>「${safeTitle}」の確認依頼が届いています。</p>` +
				`<p><a href="${safeUrl}">合意書を開く</a></p>`
		)
	};
}

function htmlDocument(lang: 'en' | 'ja', body: string): string {
	return `<!doctype html><html lang="${lang}"><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function sealContext(claim: ClaimedInvitationDelivery): CapabilitySealContext {
	return {
		organizationId: claim.organizationId,
		envelopeId: claim.envelopeId,
		recipientId: claim.recipientId,
		deliveryId: claim.deliveryId
	};
}

function requiredSealedCapability(claim: ClaimedInvitationDelivery): string {
	if (claim.sealedCapability === null) throw new Error('ciphertext_missing');
	return claim.sealedCapability;
}

function isActiveExpiry(expiresAt: string | null, now: Date): boolean {
	if (expiresAt === null) return false;
	const expiry: number = Date.parse(expiresAt);
	if (!Number.isFinite(expiry)) return false;
	return expiry > now.valueOf();
}

function assertPublicHttpsOrigin(origin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new InvalidInvitationDeliveryConfigError();
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.pathname !== '/' ||
		parsed.search !== '' ||
		parsed.hash !== ''
	) {
		throw new InvalidInvitationDeliveryConfigError();
	}
	return `${parsed.origin}/`;
}

function assertSenderConfig(sender: InvitationSenderConfig): InvitationSenderConfig {
	if (
		!isValidMailbox(sender.fromEmail) ||
		sender.fromName.length === 0 ||
		sender.fromName.length > 200 ||
		hasControlCharacters(sender.fromName)
	) {
		throw new InvalidInvitationDeliveryConfigError();
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

function safeDisplayText(value: string): string {
	return Array.from(value, (character: string): string =>
		isControlCharacter(character) ? ' ' : character
	)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
	const codePoint: number = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || codePoint === 0x7f;
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
