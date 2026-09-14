import {
	boundCompletionDeliveryClaimLimit,
	boundCompletionDeliveryDiscoveryLimit,
	MAX_COMPLETION_DELIVERY_CLAIM_BATCH,
	MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH,
	sanitizeCompletionDeliveryErrorCode,
	type ClaimedCompletionDelivery,
	type CompleteCompletionDeliveryResult,
	type CompletionDeliveryStore,
	type EligibleCompletionDeliveryRecipient,
	type EligibleRecipientRole,
	type EnrollCompletionDeliveryItem,
	type FailCompletionDeliveryResult
} from '$lib/ports/completion-delivery-store';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import { newOpaqueToken, type OpaqueTokenGenerator } from '$lib/security/opaque-token';
import {
	mailProviderReceiptId,
	MailDeliveryError,
	type MailMessage,
	type MailSendReceipt,
	type MailSender
} from '$lib/ports/mail-sender';
import {
	completionAccessPath,
	computeCompletionAccessExpiry,
	hashCompletionToken,
	issueCompletionToken
} from '$lib/security/completion-token';
import type {
	CompletionTokenOpener,
	CompletionTokenSealContext,
	CompletionTokenSealer,
	SealedCompletionToken
} from '$lib/security/completion-token-sealer';
import {
	renderCompletionMail,
	type TransactionalMailCopy
} from '$lib/application/mail/transactional-email';

export const COMPLETION_DELIVERY_CLAIM_LEASE_MS: number = 5 * 60 * 1000;
export const COMPLETION_DELIVERY_RETRY_BASE_DELAY_MS: number = 30_000;
export const COMPLETION_DELIVERY_RETRY_MAX_DELAY_MS: number = 6 * 60 * 60 * 1000;
export const MAX_COMPLETION_DELIVERY_ATTEMPTS: number = 10;
export const COMPLETION_DELIVERY_CONCURRENCY: number = 5;

const ELIGIBLE_RECIPIENT_ROLES = new Set<EligibleRecipientRole>([
	'signer',
	'approver',
	'viewer',
	'cc'
]);

export interface CompletionSenderConfig {
	fromEmail: string;
	fromName: string;
}

export type CompletionDeliverySenderConfig = CompletionSenderConfig;

export interface CompletionTokenCryptor {
	currentSealingKeyId(): Promise<string>;
	isKnownSealingKeyId(keyId: string): Promise<boolean>;
	seal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken>;
	open(
		sealedToken: string,
		context: CompletionTokenSealContext,
		sealingKeyId: string
	): Promise<string>;
}

export type CompletionDeliveryItemOutcome =
	| { deliveryId: string; outcome: 'delivered' }
	| { deliveryId: string; outcome: 'stale' }
	| {
			deliveryId: string;
			outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed';
			errorCode: string;
	  };

export interface CompletionDeliveryBatchResult {
	discovered: number;
	seeded: number;
	claimed: number;
	delivered: number;
	retryableFailed: number;
	permanentlyFailed: number;
	integrityFailed: number;
	stale: number;
	outcomes: readonly CompletionDeliveryItemOutcome[];
}

export interface DeliverPendingCompletionsOptions {
	claimLimit?: number;
	discoveryLimit?: number;
}

export class InvalidCompletionDeliveryConfigError extends Error {
	constructor() {
		super('Completion delivery configuration is invalid');
		this.name = 'InvalidCompletionDeliveryConfigError';
	}
}

export class CompletionDeliveryService {
	readonly #store: CompletionDeliveryStore;
	readonly #cryptor: CompletionTokenCryptor;
	readonly #mail: MailSender;
	readonly #publicHttpsOrigin: string;
	readonly #sender: CompletionSenderConfig;
	readonly #now: () => Date;
	readonly #newClaimToken: OpaqueTokenGenerator;
	readonly #newId: UuidV7Generator;

	constructor(
		store: CompletionDeliveryStore,
		cryptor:
			CompletionTokenCryptor | { sealer: CompletionTokenSealer; opener: CompletionTokenOpener },
		mail: MailSender,
		publicHttpsOrigin: string,
		sender: CompletionSenderConfig,
		now: () => Date = (): Date => new Date(),
		// A lease token is opaque unguessable material, never a row identifier:
		// 256 random bits with no embedded creation time.
		newClaimToken: OpaqueTokenGenerator = newOpaqueToken,
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#cryptor =
			'seal' in cryptor && 'open' in cryptor
				? cryptor
				: {
						currentSealingKeyId: (): Promise<string> => cryptor.sealer.currentSealingKeyId(),
						isKnownSealingKeyId: (keyId: string): Promise<boolean> =>
							cryptor.opener.isKnownSealingKeyId(keyId),
						seal: (
							token: string,
							context: CompletionTokenSealContext
						): Promise<SealedCompletionToken> => cryptor.sealer.seal(token, context),
						open: (
							sealedToken: string,
							context: CompletionTokenSealContext,
							sealingKeyId: string
						): Promise<string> => cryptor.opener.open(sealedToken, context, sealingKeyId)
					};
		this.#mail = mail;
		this.#publicHttpsOrigin = assertPublicHttpsOrigin(publicHttpsOrigin);
		this.#sender = assertSenderConfig(sender);
		this.#now = now;
		this.#newClaimToken = newClaimToken;
		this.#newId = newId;
	}

	async deliverPendingCompletions(
		optionsOrLimit: DeliverPendingCompletionsOptions | number = MAX_COMPLETION_DELIVERY_CLAIM_BATCH
	): Promise<CompletionDeliveryBatchResult> {
		const claimLimit: number =
			typeof optionsOrLimit === 'number'
				? boundCompletionDeliveryClaimLimit(optionsOrLimit)
				: boundCompletionDeliveryClaimLimit(
						optionsOrLimit?.claimLimit ?? MAX_COMPLETION_DELIVERY_CLAIM_BATCH
					);
		const discoveryLimit: number =
			typeof optionsOrLimit === 'number'
				? MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH
				: boundCompletionDeliveryDiscoveryLimit(
						optionsOrLimit?.discoveryLimit ?? MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH
					);

		const now: Date = this.#now();
		const { discovered, seeded } = await this.#discoverAndSeed(discoveryLimit, now);
		const claimedAt: Date = now;
		const claimToken: string = this.#newClaimToken();
		const claims: readonly ClaimedCompletionDelivery[] = await this.#store.claimPendingDeliveries({
			claimToken,
			claimedAt: claimedAt.toISOString(),
			staleBefore: new Date(claimedAt.valueOf() - COMPLETION_DELIVERY_CLAIM_LEASE_MS).toISOString(),
			limit: claimLimit
		});

		const outcomes: CompletionDeliveryItemOutcome[] = [];
		for (
			let offset: number = 0;
			offset < claims.length;
			offset += COMPLETION_DELIVERY_CONCURRENCY
		) {
			const chunk: readonly ClaimedCompletionDelivery[] = claims.slice(
				offset,
				offset + COMPLETION_DELIVERY_CONCURRENCY
			);
			const settled: readonly PromiseSettledResult<CompletionDeliveryItemOutcome>[] =
				await Promise.allSettled(
					chunk.map((claim: ClaimedCompletionDelivery) =>
						this.#deliverClaim(claim, claimToken, claimedAt)
					)
				);
			outcomes.push(
				...settled.map(
					(
						result: PromiseSettledResult<CompletionDeliveryItemOutcome>,
						index: number
					): CompletionDeliveryItemOutcome =>
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

		return summarize(discovered, seeded, claims.length, outcomes);
	}

	async discoverAndSeedDeliveries(
		limit: number = MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH
	): Promise<{ discovered: number; seeded: number }> {
		return this.#discoverAndSeed(boundCompletionDeliveryDiscoveryLimit(limit), this.#now());
	}

	async #discoverAndSeed(
		discoveryLimit: number,
		now: Date
	): Promise<{ discovered: number; seeded: number }> {
		if (discoveryLimit <= 0) {
			return { discovered: 0, seeded: 0 };
		}
		const recipients: readonly EligibleCompletionDeliveryRecipient[] =
			await this.#store.discoverEligibleRecipients(discoveryLimit);
		if (recipients.length === 0) {
			return { discovered: 0, seeded: 0 };
		}

		const items: EnrollCompletionDeliveryItem[] = await Promise.all(
			recipients.map(
				async (
					recipient: EligibleCompletionDeliveryRecipient
				): Promise<EnrollCompletionDeliveryItem> => {
					const id: string = this.#newId();
					const issued = await issueCompletionToken();
					const context: CompletionTokenSealContext = {
						organizationId: recipient.organizationId,
						envelopeId: recipient.envelopeId,
						recipientId: recipient.recipientId,
						deliveryId: id
					};
					const sealed: SealedCompletionToken = await this.#cryptor.seal(issued.token, context);
					return {
						id,
						organizationId: recipient.organizationId,
						envelopeId: recipient.envelopeId,
						recipientId: recipient.recipientId,
						tokenHash: issued.tokenHash,
						accessExpiresAt: computeCompletionAccessExpiry(now),
						sealedToken: sealed.sealedToken,
						sealingKeyId: sealed.sealingKeyId,
						sealedTokenSha256: sealed.sealedTokenSha256,
						availableAt: now.toISOString(),
						createdAt: now.toISOString()
					};
				}
			)
		);

		const seeded: number = await this.#store.enrollDeliveries(items);
		return { discovered: recipients.length, seeded };
	}

	async #deliverClaim(
		claim: ClaimedCompletionDelivery,
		claimToken: string,
		now: Date
	): Promise<CompletionDeliveryItemOutcome> {
		const refreshed: ClaimedCompletionDelivery | null = await this.#store.readClaimedDelivery({
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
			token = await this.#cryptor.open(
				requiredSealedToken(claim),
				sealContext(claim),
				claim.sealingKeyId
			);
		} catch {
			return this.#finishFailure(
				claim,
				claimToken,
				'token_open_failed',
				false,
				now,
				'integrity_failed'
			);
		}

		let tokenHash: string;
		try {
			tokenHash = await hashCompletionToken(token);
		} catch {
			return this.#finishFailure(
				claim,
				claimToken,
				'token_hash_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}
		if (tokenHash !== claim.tokenHash) {
			return this.#finishFailure(
				claim,
				claimToken,
				'token_hash_mismatch',
				false,
				now,
				'integrity_failed'
			);
		}

		const message: MailMessage = completionMessage(
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

		const completion: CompleteCompletionDeliveryResult = await this.#store.completeDelivery({
			organizationId: claim.organizationId,
			deliveryId: claim.deliveryId,
			claimToken,
			deliveredAt: now.toISOString(),
			providerMessageId
		});
		if (completion.outcome === 'stale') return { deliveryId: claim.deliveryId, outcome: 'stale' };
		return { deliveryId: claim.deliveryId, outcome: 'delivered' };
	}

	async #verifyClaim(claim: ClaimedCompletionDelivery, now: Date): Promise<string | null> {
		if (claim.status !== 'processing') {
			return 'delivery_not_eligible';
		}
		if (claim.envelopeStatus !== 'completed') {
			return 'envelope_not_completed';
		}
		if (!ELIGIBLE_RECIPIENT_ROLES.has(claim.recipientRole)) {
			return 'recipient_role_ineligible';
		}
		if (!isValidMailbox(claim.recipientEmail)) {
			return 'recipient_email_invalid';
		}
		if (claim.accessRevokedAt !== null) {
			return 'access_revoked';
		}
		if (!isActiveExpiry(claim.accessExpiresAt, now)) {
			return 'access_expired';
		}
		if (claim.sealedToken === null || claim.sealedToken.length === 0) {
			return 'ciphertext_missing';
		}
		const digest: string = await sha256Hex(claim.sealedToken);
		if (digest !== claim.sealedTokenSha256) {
			return 'ciphertext_digest_mismatch';
		}
		if (!(await this.#cryptor.isKnownSealingKeyId(claim.sealingKeyId))) {
			return 'sealing_key_mismatch';
		}
		return null;
	}

	async #finishFailure(
		claim: ClaimedCompletionDelivery,
		claimToken: string,
		errorCode: string,
		retryable: boolean,
		now: Date,
		outcome: 'retryable_failed' | 'permanently_failed' | 'integrity_failed'
	): Promise<CompletionDeliveryItemOutcome> {
		const attemptsExhausted: boolean =
			retryable && claim.attempts >= MAX_COMPLETION_DELIVERY_ATTEMPTS;
		const willRetry: boolean = retryable && !attemptsExhausted;
		const safeCode: string = sanitizeCompletionDeliveryErrorCode(
			attemptsExhausted ? 'delivery_attempts_exhausted' : errorCode
		);
		const failure: FailCompletionDeliveryResult = await this.#store.failDelivery({
			organizationId: claim.organizationId,
			deliveryId: claim.deliveryId,
			claimToken,
			errorCode: safeCode,
			retryable: willRetry,
			nextAvailableAt: willRetry
				? completionDeliveryRetryAvailableAt(now, claim.attempts)
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

export function completionDeliveryRetryAvailableAt(now: Date, attempts: number): string {
	const safeAttempts: number = Math.max(1, attempts);
	const exponent: number = Math.min(safeAttempts - 1, 10);
	const delayMs: number = Math.min(
		COMPLETION_DELIVERY_RETRY_MAX_DELAY_MS,
		COMPLETION_DELIVERY_RETRY_BASE_DELAY_MS * 2 ** exponent
	);
	return new Date(now.valueOf() + delayMs).toISOString();
}

function summarize(
	discovered: number,
	seeded: number,
	claimed: number,
	outcomes: readonly CompletionDeliveryItemOutcome[]
): CompletionDeliveryBatchResult {
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
		discovered,
		seeded,
		claimed,
		delivered,
		retryableFailed,
		permanentlyFailed,
		integrityFailed,
		stale,
		outcomes
	};
}

function completionMessage(
	claim: ClaimedCompletionDelivery,
	sender: CompletionSenderConfig,
	origin: string,
	token: string
): MailMessage {
	const completionUrl: string = new URL(completionAccessPath(token), origin).href;
	const title: string = safeDisplayText(claim.envelopeTitle).slice(0, 300);
	const name: string = safeDisplayText(claim.recipientName).slice(0, 200);
	const copy: TransactionalMailCopy = renderCompletionMail(
		claim.recipientLocale === 'ja' ? 'ja' : 'en',
		name,
		title,
		completionUrl
	);
	return {
		to: claim.recipientEmail,
		from: { email: sender.fromEmail, name: sender.fromName },
		subject: copy.subject,
		text: copy.text,
		html: copy.html,
		deliveryKey: `signkit-completion-delivery-v1:${claim.organizationId}:${claim.deliveryId}`
	};
}

function sealContext(claim: ClaimedCompletionDelivery): CompletionTokenSealContext {
	return {
		organizationId: claim.organizationId,
		envelopeId: claim.envelopeId,
		recipientId: claim.recipientId,
		deliveryId: claim.deliveryId
	};
}

function requiredSealedToken(claim: ClaimedCompletionDelivery): string {
	if (claim.sealedToken === null) throw new Error('ciphertext_missing');
	return claim.sealedToken;
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
		throw new InvalidCompletionDeliveryConfigError();
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.pathname !== '/' ||
		parsed.search !== '' ||
		parsed.hash !== ''
	) {
		throw new InvalidCompletionDeliveryConfigError();
	}
	return `${parsed.origin}/`;
}

function assertSenderConfig(sender: CompletionSenderConfig): CompletionSenderConfig {
	if (
		!isValidMailbox(sender.fromEmail) ||
		sender.fromName.length === 0 ||
		sender.fromName.length > 200 ||
		hasControlCharacters(sender.fromName)
	) {
		throw new InvalidCompletionDeliveryConfigError();
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
