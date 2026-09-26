import { describe, expect, it } from 'vitest';
import type {
	ClaimCompletionDeliveriesCommand,
	ClaimedCompletionDelivery,
	CompleteCompletionDeliveryCommand,
	CompleteCompletionDeliveryResult,
	CompletionArtifactLocator,
	CompletionDeliveryStore,
	EligibleCompletionDeliveryRecipient,
	EnrollCompletionDeliveryItem,
	FailCompletionDeliveryCommand,
	FailCompletionDeliveryResult,
	ReadClaimedCompletionDeliveryCommand
} from '$lib/ports/completion-delivery-store';
import {
	MailDeliveryError,
	type MailMessage,
	type MailSendReceipt,
	type MailSender
} from '$lib/ports/mail-sender';
import { hashCompletionToken, issueCompletionToken } from '$lib/security/completion-token';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { OPAQUE_TOKEN_PATTERN } from '$lib/security/opaque-token';
import {
	AesGcmCompletionTokenSealer,
	type CompletionTokenSealContext,
	type SealedCompletionToken
} from '$lib/security/completion-token-sealer';
import {
	CompletionDeliveryService,
	completionDeliveryRetryAvailableAt,
	InvalidCompletionDeliveryConfigError,
	type CompletionTokenCryptor
} from './completion-delivery-service';
import {
	MissingCompletionPdfAttachmentReader,
	type CompletionPdfAttachmentOutcome,
	type CompletionPdfAttachmentReaderPort
} from './completion-pdf-attachment-reader';

const NOW: Date = new Date('2026-09-12T00:00:00.000Z');
const ORIGIN: string = 'https://signkit.example';
const SENDER = { fromEmail: 'noreply@signkit.example', fromName: 'SignKit' } as const;
const CLAIM_TOKEN: string = 'lease-opaque-claim-token-0001';
const SEALING_KEY: string = btoa(
	String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + 1))
);

class FakeStore implements CompletionDeliveryStore {
	readonly discoveredCalls: number[] = [];
	readonly enrolled: EnrollCompletionDeliveryItem[][] = [];
	readonly claims: ClaimCompletionDeliveriesCommand[] = [];
	readonly completions: CompleteCompletionDeliveryCommand[] = [];
	readonly failures: FailCompletionDeliveryCommand[] = [];
	readonly reads: ReadClaimedCompletionDeliveryCommand[] = [];

	discoveredRecipients: EligibleCompletionDeliveryRecipient[] = [];
	rows: ClaimedCompletionDelivery[] = [];
	readResult: ClaimedCompletionDelivery | null | undefined;
	readErrors: Set<string> = new Set();
	completeResult: CompleteCompletionDeliveryResult = { outcome: 'completed' };
	failResult: FailCompletionDeliveryResult = { outcome: 'failed' };

	async discoverEligibleRecipients(
		limit: number
	): Promise<readonly EligibleCompletionDeliveryRecipient[]> {
		this.discoveredCalls.push(limit);
		return this.discoveredRecipients.slice(0, limit);
	}

	async enrollDeliveries(items: readonly EnrollCompletionDeliveryItem[]): Promise<number> {
		this.enrolled.push([...items]);
		return items.length;
	}

	async claimPendingDeliveries(
		command: ClaimCompletionDeliveriesCommand
	): Promise<readonly ClaimedCompletionDelivery[]> {
		this.claims.push(command);
		return this.rows.slice(0, command.limit);
	}

	async readClaimedDelivery(
		command: ReadClaimedCompletionDeliveryCommand
	): Promise<ClaimedCompletionDelivery | null> {
		this.reads.push(command);
		if (this.readErrors.has(command.deliveryId)) throw new Error('database unavailable');
		if (this.readResult !== undefined) return this.readResult;
		return (
			this.rows.find(
				(row: ClaimedCompletionDelivery): boolean => row.deliveryId === command.deliveryId
			) ?? null
		);
	}

	async completeDelivery(
		command: CompleteCompletionDeliveryCommand
	): Promise<CompleteCompletionDeliveryResult> {
		this.completions.push(command);
		return this.completeResult;
	}

	async failDelivery(
		command: FailCompletionDeliveryCommand
	): Promise<FailCompletionDeliveryResult> {
		this.failures.push(command);
		return this.failResult;
	}

	async resolveArtifactLocatorByTokenHash(): Promise<CompletionArtifactLocator | null> {
		return null;
	}

	async findStaleSealedCompletionTokens(): Promise<[]> {
		return [];
	}

	async resealCompletionToken(): Promise<{ outcome: 'stale' }> {
		return { outcome: 'stale' };
	}
}

class FakeCryptor implements CompletionTokenCryptor {
	readonly sealCalls: { token: string; context: CompletionTokenSealContext }[] = [];
	readonly openCalls: {
		sealed: string;
		context: CompletionTokenSealContext;
		sealingKeyId: string;
	}[] = [];
	keyLookups: number = 0;
	currentKeyId: string = 'key-1';
	throwOnOpen: boolean = false;
	openError: Error = new Error('open failed');

	constructor(private token: string) {}

	setToken(token: string): void {
		this.token = token;
	}

	async currentSealingKeyId(): Promise<string> {
		this.keyLookups += 1;
		return this.currentKeyId;
	}

	async isKnownSealingKeyId(keyId: string): Promise<boolean> {
		this.keyLookups += 1;
		return keyId === this.currentKeyId;
	}

	async seal(token: string, context: CompletionTokenSealContext): Promise<SealedCompletionToken> {
		this.sealCalls.push({ token, context });
		const sealedToken: string = `skcd1_fake_sealed_${token.slice(6)}`;
		return {
			sealedToken,
			sealingKeyId: this.currentKeyId,
			sealedTokenSha256: await sha256Hex(sealedToken)
		};
	}

	async open(
		sealedToken: string,
		context: CompletionTokenSealContext,
		sealingKeyId: string
	): Promise<string> {
		this.openCalls.push({ sealed: sealedToken, context, sealingKeyId });
		if (this.throwOnOpen) throw this.openError;
		return this.token;
	}
}

class FakeMail implements MailSender {
	readonly messages: MailMessage[] = [];
	error: Error | null = null;
	receipt: MailSendReceipt = {
		outcome: 'accepted',
		providerMessageId: 'provider-1'
	};

	async send(message: MailMessage): Promise<MailSendReceipt> {
		this.messages.push(message);
		if (this.error !== null) throw this.error;
		return this.receipt;
	}
}

class FakePdfAttachmentReader implements CompletionPdfAttachmentReaderPort {
	readonly envelopeIds: string[] = [];
	outcome: CompletionPdfAttachmentOutcome;

	constructor(
		outcome: CompletionPdfAttachmentOutcome = {
			outcome: 'attached',
			bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
			byteSize: 4
		}
	) {
		this.outcome = outcome;
	}

	async read(envelopeId: string): Promise<CompletionPdfAttachmentOutcome> {
		this.envelopeIds.push(envelopeId);
		return this.outcome;
	}
}

class TrackingMail extends FakeMail {
	active: number = 0;
	maximumActive: number = 0;

	override async send(message: MailMessage): Promise<MailSendReceipt> {
		this.messages.push(message);
		this.active += 1;
		this.maximumActive = Math.max(this.maximumActive, this.active);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		this.active -= 1;
		return this.receipt;
	}
}

function service(
	store: FakeStore,
	cryptor: CompletionTokenCryptor,
	mail: FakeMail,
	newClaimToken: () => string = (): string => CLAIM_TOKEN,
	pdfAttachmentReader: CompletionPdfAttachmentReaderPort | null = new FakePdfAttachmentReader()
): CompletionDeliveryService {
	return new CompletionDeliveryService(
		store,
		cryptor,
		mail,
		ORIGIN,
		SENDER,
		(): Date => NOW,
		newClaimToken,
		undefined,
		pdfAttachmentReader
	);
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

async function eligibleClaim(
	overrides: Partial<ClaimedCompletionDelivery> & { token?: string } = {}
): Promise<{
	claim: ClaimedCompletionDelivery;
	token: string;
}> {
	const issued = await issueCompletionToken();
	const { token: requestedToken, ...claimOverrides } = overrides;
	const token: string = requestedToken ?? issued.token;
	const sealedToken: string = claimOverrides.sealedToken ?? `skcd1_fake_sealed_${token.slice(6)}`;
	const sealedTokenSha256: string =
		claimOverrides.sealedTokenSha256 ?? (await sha256Hex(sealedToken));
	const tokenHash: string =
		claimOverrides.tokenHash ??
		(requestedToken === undefined ? issued.tokenHash : await hashCompletionToken(requestedToken));
	return {
		token,
		claim: {
			deliveryId: 'delivery-1',
			envelopeId: 'envelope-1',
			recipientId: 'recipient-1',
			status: 'processing',
			recipientEmail: 'alex@example.com',
			recipientName: 'Alex',
			recipientLocale: 'en',
			recipientRole: 'signer',
			envelopeTitle: 'Service Agreement',
			envelopeStatus: 'completed',
			tokenHash,
			accessExpiresAt: '2026-10-12T00:00:00.000Z',
			accessRevokedAt: null,
			sealedToken,
			sealedTokenSha256,
			sealingKeyId: 'key-1',
			availableAt: '2026-09-11T23:00:00.000Z',
			attempts: 1,
			lockedAt: NOW.toISOString(),
			...claimOverrides
		}
	};
}

function secretNeedles(token: string, claim: ClaimedCompletionDelivery): readonly string[] {
	return [
		token,
		claim.tokenHash,
		claim.recipientEmail,
		claim.recipientName,
		claim.envelopeTitle,
		claim.sealedToken ?? 'skcd1_',
		claim.sealedTokenSha256,
		'/c/'
	];
}

function assertNoSecrets(value: unknown, needles: readonly string[]): void {
	const encoded: string = JSON.stringify(value);
	for (const needle of needles) {
		if (needle.length === 0) continue;
		expect(encoded).not.toContain(needle);
	}
}

describe('CompletionDeliveryService', () => {
	describe('no-publication gate delegated to discovery', () => {
		it('delegates publication gating to discovery: does not seed when discovery finds 0 published envelopes', async () => {
			const store: FakeStore = new FakeStore();
			store.discoveredRecipients = []; // envelope has completed status but no published completion artifact
			const cryptor: FakeCryptor = new FakeCryptor('skca1_fake_token_000000000000000000000000000');
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result).toMatchObject({
				discovered: 0,
				seeded: 0,
				claimed: 0,
				delivered: 0,
				outcomes: []
			});
			expect(store.discoveredCalls).toEqual([25]);
			expect(store.enrolled).toHaveLength(0);
			expect(cryptor.sealCalls).toHaveLength(0);
			expect(mail.messages).toHaveLength(0);
		});

		it('discovers and seeds deliveries when envelope has a published artifact, then claims and delivers', async () => {
			const sealer = new AesGcmCompletionTokenSealer(SEALING_KEY);
			const recipient: EligibleCompletionDeliveryRecipient = {
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				recipientEmail: 'morgan@example.com',
				recipientName: 'Morgan',
				recipientLocale: 'en',
				recipientRole: 'approver',
				envelopeTitle: 'Partnership Agreement'
			};
			const store: FakeStore = new FakeStore();
			store.discoveredRecipients = [recipient];

			let seededItem: EnrollCompletionDeliveryItem | undefined;
			store.enrollDeliveries = async (
				items: readonly EnrollCompletionDeliveryItem[]
			): Promise<number> => {
				store.enrolled.push([...items]);
				seededItem = items[0];
				if (seededItem !== undefined) {
					store.rows = [
						{
							deliveryId: seededItem.id,
							envelopeId: seededItem.envelopeId,
							recipientId: seededItem.recipientId,
							status: 'processing',
							tokenHash: seededItem.tokenHash,
							accessExpiresAt: seededItem.accessExpiresAt,
							accessRevokedAt: null,
							sealedToken: seededItem.sealedToken,
							sealingKeyId: seededItem.sealingKeyId,
							sealedTokenSha256: seededItem.sealedTokenSha256,
							availableAt: seededItem.availableAt,
							attempts: 1,
							lockedAt: NOW.toISOString(),
							recipientEmail: recipient.recipientEmail,
							recipientName: recipient.recipientName,
							recipientLocale: recipient.recipientLocale,
							recipientRole: recipient.recipientRole,
							envelopeTitle: recipient.envelopeTitle,
							envelopeStatus: 'completed'
						}
					];
				}
				return items.length;
			};

			const mail: FakeMail = new FakeMail();
			const result = await service(store, sealer, mail).deliverPendingCompletions();

			expect(result).toMatchObject({
				discovered: 1,
				seeded: 1,
				claimed: 1,
				delivered: 1,
				retryableFailed: 0,
				permanentlyFailed: 0,
				integrityFailed: 0,
				stale: 0
			});
			expect(store.enrolled).toHaveLength(1);
			expect(store.enrolled[0][0]).toMatchObject({
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				availableAt: NOW.toISOString(),
				createdAt: NOW.toISOString()
			});
			expect(store.completions).toHaveLength(1);
			expect(mail.messages).toHaveLength(1);
			expect(mail.messages[0].to).toBe('morgan@example.com');
			expect(mail.messages[0].subject).toBe('Completed: "Partnership Agreement"');
			expect(mail.messages[0].text).toContain('Hello Morgan,');
			expect(mail.messages[0].html).toContain('View completed documents');
		});

		it('mints a UUIDv7 delivery row identifier while the claim token stays opaque', async () => {
			const sealer = new AesGcmCompletionTokenSealer(SEALING_KEY);
			const store: FakeStore = new FakeStore();
			store.discoveredRecipients = [
				{
					envelopeId: 'envelope-1',
					recipientId: 'recipient-1',
					recipientEmail: 'morgan@example.com',
					recipientName: 'Morgan',
					recipientLocale: 'en',
					recipientRole: 'approver',
					envelopeTitle: 'Partnership Agreement'
				}
			];

			await new CompletionDeliveryService(
				store,
				sealer,
				new FakeMail(),
				ORIGIN,
				SENDER,
				(): Date => NOW
			).deliverPendingCompletions();

			expect(store.enrolled[0][0].id).toMatch(UUID_V7_PATTERN);
			expect(store.claims[0].claimToken).toMatch(OPAQUE_TOKEN_PATTERN);
			expect(store.claims[0].claimToken).not.toMatch(UUID_V7_PATTERN);
		});
	});

	describe('EN/JA escaping', () => {
		it('safely escapes special characters in English completion emails', async () => {
			const { claim, token } = await eligibleClaim({
				recipientLocale: 'en',
				recipientName: 'Alice <script>alert("xss")</script> & O\'Connor',
				envelopeTitle: 'NDA "Special" & <Offer> 2026'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.delivered).toBe(1);
			expect(mail.messages).toHaveLength(1);
			const msg: MailMessage = mail.messages[0];
			expect(msg.subject).toBe('Completed: "NDA "Special" & <Offer> 2026"');
			expect(msg.text).toContain('Hello Alice <script>alert("xss")</script> & O\'Connor,');
			expect(msg.text).toContain(
				'"NDA "Special" & <Offer> 2026" has been completed by all participants.'
			);
			expect(msg.text).toContain(`https://signkit.example/c/${token}/view`);

			// HTML escaping checks
			expect(msg.html).toContain('lang="en"');
			expect(msg.html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
			expect(msg.html).toContain('O&#39;Connor');
			expect(msg.html).toContain('NDA &quot;Special&quot; &amp; &lt;Offer&gt; 2026');
			expect(msg.html).toContain(`href="https://signkit.example/c/${token}/view"`);
			expect(msg.html).toContain('View completed documents');
			expect(msg.html).not.toContain('<script>');
		});

		it('safely escapes special characters in Japanese completion emails', async () => {
			const { claim, token } = await eligibleClaim({
				recipientLocale: 'ja',
				recipientName: '佐藤 <次郎> & "顧問"',
				envelopeTitle: '業務委託契約書 <甲乙> & "覚書"'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.delivered).toBe(1);
			expect(mail.messages).toHaveLength(1);
			const msg: MailMessage = mail.messages[0];
			expect(msg.subject).toBe('「業務委託契約書 <甲乙> & "覚書"」の手続きが完了しました');
			expect(msg.text).toContain('佐藤 <次郎> & "顧問" 様');
			expect(msg.text).toContain('「業務委託契約書 <甲乙> & "覚書"」の手続きが完了しました。');
			expect(msg.text).toContain(`https://signkit.example/ja/c/${token}/view`);

			// HTML escaping checks
			expect(msg.html).toContain('lang="ja"');
			expect(msg.html).toContain('&lt;次郎&gt;');
			expect(msg.html).toContain('&quot;顧問&quot;');
			expect(msg.html).toContain('業務委託契約書 &lt;甲乙&gt; &amp; &quot;覚書&quot;');
			expect(msg.html).toContain(`href="https://signkit.example/ja/c/${token}/view"`);
			expect(msg.html).toContain('完了した契約書を開く');
			expect(msg.html).not.toContain('合意書');
			expect(msg.text).not.toContain('合意書');
		});
	});

	describe('same-batch isolation', () => {
		it('isolates a per-item store read failure using Promise.allSettled so siblings complete', async () => {
			const first = await eligibleClaim({ deliveryId: 'delivery-1', recipientId: 'rec-1' });
			const second = await eligibleClaim({ deliveryId: 'delivery-2', recipientId: 'rec-2' });
			const store: FakeStore = new FakeStore();
			store.rows = [first.claim, second.claim];
			store.readErrors.add('delivery-1');
			const cryptor: FakeCryptor = new FakeCryptor(second.token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result).toMatchObject({
				claimed: 2,
				delivered: 1,
				retryableFailed: 1,
				permanentlyFailed: 0,
				integrityFailed: 0,
				stale: 0
			});
			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'delivery_store_unavailable'
				},
				{
					deliveryId: 'delivery-2',
					outcome: 'delivered'
				}
			]);
			expect(mail.messages).toHaveLength(1);
			expect(mail.messages[0].deliveryKey).toContain('delivery-2');
			expect(store.completions).toHaveLength(1);
			expect(store.completions[0].deliveryId).toBe('delivery-2');
		});
	});

	describe('stale lease', () => {
		it('returns stale outcome and skips open/send when refreshed claim is null', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			store.readResult = null; // lease stolen or expired
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result).toMatchObject({ claimed: 1, delivered: 0, stale: 1 });
			expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'stale' }]);
			expect(cryptor.openCalls).toHaveLength(0);
			expect(mail.messages).toHaveLength(0);
			expect(store.completions).toHaveLength(0);
			expect(store.failures).toHaveLength(0);
		});

		it('returns stale outcome when completeDelivery CAS misses', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			store.completeResult = { outcome: 'stale' };
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result).toMatchObject({ claimed: 1, delivered: 0, stale: 1 });
			expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'stale' }]);
			expect(mail.messages).toHaveLength(1);
		});

		it('returns stale outcome when failDelivery CAS misses', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			store.failResult = { outcome: 'stale' };
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			mail.error = new MailDeliveryError('smtp_temporary_failure', true);

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result).toMatchObject({ claimed: 1, delivered: 0, stale: 1 });
			expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'stale' }]);
			expect(store.failures).toHaveLength(1);
		});
	});

	describe('retryable vs terminal classification and undisclosed grant revocation', () => {
		it('classifies retryable mail failure, computes backoff, and preserves undisclosed grant in store', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 2 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			mail.error = new MailDeliveryError('connection_refused', true);

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'connection_refused'
				}
			]);
			expect(store.failures).toHaveLength(1);
			expect(store.failures[0]).toMatchObject({
				deliveryId: 'delivery-1',
				errorCode: 'connection_refused',
				retryable: true,
				nextAvailableAt: completionDeliveryRetryAvailableAt(NOW, 2)
			});
		});

		it('classifies terminal provider failure and revokes undisclosed grant (retryable: false)', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 1 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			mail.error = new MailDeliveryError('recipient_mailbox_not_found', false);

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'permanently_failed',
					errorCode: 'recipient_mailbox_not_found'
				}
			]);
			expect(store.failures).toHaveLength(1);
			expect(store.failures[0]).toMatchObject({
				deliveryId: 'delivery-1',
				errorCode: 'recipient_mailbox_not_found',
				retryable: false,
				nextAvailableAt: NOW.toISOString()
			});
		});

		it('exhausts attempts when attempts >= 10, terminally revoking even on retryable error', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 10 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			mail.error = new MailDeliveryError('smtp_timeout', true);

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'permanently_failed',
					errorCode: 'delivery_attempts_exhausted'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'delivery_attempts_exhausted'
			});
		});

		it('treats sealing key mismatch as retryable integrity failure', async () => {
			const { claim, token } = await eligibleClaim({ sealingKeyId: 'key-old' });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			cryptor.currentKeyId = 'key-new';
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'sealing_key_mismatch'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: true,
				errorCode: 'sealing_key_mismatch'
			});
			expect(cryptor.openCalls).toHaveLength(0);
			expect(mail.messages).toHaveLength(0);
		});

		it('treats decryption authentication failure as terminal integrity failure and revokes grant', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			cryptor.throwOnOpen = true;
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'token_open_failed'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'token_open_failed'
			});
			expect(mail.messages).toHaveLength(0);
		});

		it('treats token hash mismatch as terminal integrity failure and revokes grant', async () => {
			const { claim, token } = await eligibleClaim({ tokenHash: 'hash-that-does-not-match' });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'token_hash_mismatch'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'token_hash_mismatch'
			});
		});

		it('treats expired access token as terminal integrity failure', async () => {
			const { claim, token } = await eligibleClaim({
				accessExpiresAt: '2026-09-11T23:59:59.000Z' // before NOW
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'access_expired'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'access_expired'
			});
		});

		it('treats revoked access token as terminal integrity failure', async () => {
			const { claim, token } = await eligibleClaim({
				accessRevokedAt: '2026-09-11T23:59:59.000Z'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'access_revoked'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'access_revoked'
			});
		});

		it('treats non-completed envelope as terminal integrity failure', async () => {
			const { claim, token } = await eligibleClaim({
				envelopeStatus: 'in_progress'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'envelope_not_completed'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'envelope_not_completed'
			});
		});

		it('treats corrupted ciphertext sha256 mismatch as terminal integrity failure', async () => {
			const { claim, token } = await eligibleClaim({
				sealedTokenSha256: '0000000000000000000000000000000000000000000000000000000000000000'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'ciphertext_digest_mismatch'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'ciphertext_digest_mismatch'
			});
		});
	});

	describe('published completion PDF attachment', () => {
		it('sends the completed PDF as a byte-preserving attachment with attached copy when verified', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new FakePdfAttachmentReader();
			const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
			reader.outcome = { outcome: 'attached', bytes, byteSize: bytes.byteLength };

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'delivered' }]);
			expect(reader.envelopeIds).toEqual(['envelope-1']);
			expect(mail.messages).toHaveLength(1);
			expect(mail.messages[0].attachment).toEqual({
				filename: 'signkit-completed-envelope-1.pdf',
				contentType: 'application/pdf',
				content: bytes
			});
			expect(mail.messages[0].text).toContain(
				'The completed PDF is attached to this email for your records.'
			);
		});

		it('treats a PDF that has not been published yet as a retryable delivery failure, never a silent link-only send', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 2 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new FakePdfAttachmentReader();
			reader.outcome = { outcome: 'unpublished' };

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'completion_pdf_not_yet_published'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: true,
				errorCode: 'completion_pdf_not_yet_published',
				nextAvailableAt: completionDeliveryRetryAvailableAt(NOW, 2)
			});
			expect(mail.messages).toHaveLength(0);
		});

		it('sends no attachment and fallback copy when the published PDF exceeds the mail attachment budget', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new FakePdfAttachmentReader();
			reader.outcome = { outcome: 'oversize', byteSize: 4 * 1024 * 1024 };

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'delivered' }]);
			expect(mail.messages[0].attachment).toBeUndefined();
			expect(mail.messages[0].text).toContain(
				'Due to its file size, the completed PDF is not attached to this email.'
			);
		});

		it('treats a transient PDF/object read failure as a retryable delivery failure, never a silent link-only send', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 2 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new FakePdfAttachmentReader();
			reader.outcome = { outcome: 'retryable_error', errorCode: 'completion_pdf_object_missing' };

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'completion_pdf_object_missing'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: true,
				errorCode: 'completion_pdf_object_missing',
				nextAvailableAt: completionDeliveryRetryAvailableAt(NOW, 2)
			});
			expect(mail.messages).toHaveLength(0);
		});

		it('fails closed as a non-retryable integrity failure on digest/key/size mismatch, never a silent link-only send', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new FakePdfAttachmentReader();
			reader.outcome = { outcome: 'integrity_error', errorCode: 'completion_pdf_digest_mismatch' };

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'integrity_failed',
					errorCode: 'completion_pdf_digest_mismatch'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: false,
				errorCode: 'completion_pdf_digest_mismatch'
			});
			expect(mail.messages).toHaveLength(0);
		});

		it('treats a null attachment reader as a retryable failure, never a silent link-only send', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 2 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				null
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'completion_pdf_storage_not_configured'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: true,
				errorCode: 'completion_pdf_storage_not_configured',
				nextAvailableAt: completionDeliveryRetryAvailableAt(NOW, 2)
			});
			expect(mail.messages).toHaveLength(0);
		});

		it('treats a missing production attachment reader (no object storage configured) as a retryable delivery failure, never a silent link-only send', async () => {
			const { claim, token } = await eligibleClaim({ attempts: 2 });
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			const reader = new MissingCompletionPdfAttachmentReader();

			const result = await service(
				store,
				cryptor,
				mail,
				undefined,
				reader
			).deliverPendingCompletions();

			expect(result.outcomes).toEqual([
				{
					deliveryId: 'delivery-1',
					outcome: 'retryable_failed',
					errorCode: 'completion_pdf_storage_not_configured'
				}
			]);
			expect(store.failures[0]).toMatchObject({
				retryable: true,
				errorCode: 'completion_pdf_storage_not_configured',
				nextAvailableAt: completionDeliveryRetryAvailableAt(NOW, 2)
			});
			expect(mail.messages).toHaveLength(0);
		});
	});

	describe('stable token reclaim', () => {
		it('preserves the original sealed token across retries and delivers the same token upon recovery', async () => {
			const issued = await issueCompletionToken();
			const sealer = new AesGcmCompletionTokenSealer(SEALING_KEY);
			const context: CompletionTokenSealContext = {
				envelopeId: 'envelope-1',
				recipientId: 'recipient-1',
				deliveryId: 'delivery-1'
			};
			const sealed = await sealer.seal(issued.token, context);
			const { claim } = await eligibleClaim({
				token: issued.token,
				tokenHash: issued.tokenHash,
				sealedToken: sealed.sealedToken,
				sealedTokenSha256: sealed.sealedTokenSha256,
				sealingKeyId: sealed.sealingKeyId,
				attempts: 2 // retry attempt
			});

			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const mail: FakeMail = new FakeMail();

			const result = await service(store, sealer, mail).deliverPendingCompletions();

			expect(result).toMatchObject({
				claimed: 1,
				delivered: 1,
				retryableFailed: 0,
				permanentlyFailed: 0,
				integrityFailed: 0
			});
			expect(mail.messages).toHaveLength(1);
			expect(mail.messages[0].text).toContain(`https://signkit.example/c/${issued.token}/view`);
			expect(mail.messages[0].html).toContain(
				`href="https://signkit.example/c/${issued.token}/view"`
			);
			expect(store.completions).toHaveLength(1);
			expect(store.completions[0]).toMatchObject({
				deliveryId: 'delivery-1',
				claimToken: CLAIM_TOKEN
			});
		});
	});

	describe('result secrecy', () => {
		it('returns only IDs, outcomes, and safe error codes with no secrets or PII in results or store calls', async () => {
			const { claim, token } = await eligibleClaim({
				recipientEmail: 'confidential.client@private.domain.example',
				recipientName: 'Secret Client Name',
				envelopeTitle: 'Strictly Confidential Merger Agreement'
			});
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.delivered).toBe(1);
			const needles = secretNeedles(token, claim);
			assertNoSecrets(result, needles);
			assertNoSecrets(store.completions, needles);
		});

		it('sanitizes error codes and does not leak token secrets in failure command or outcome', async () => {
			const { claim, token } = await eligibleClaim();
			const store: FakeStore = new FakeStore();
			store.rows = [claim];
			const cryptor: FakeCryptor = new FakeCryptor(token);
			const mail: FakeMail = new FakeMail();
			// Attempt to leak token in error code
			mail.error = new MailDeliveryError(`skca1_secret_token_leak`, true);

			const result = await service(store, cryptor, mail).deliverPendingCompletions();

			expect(result.outcomes[0].outcome).toBe('retryable_failed');
			expect((result.outcomes[0] as { errorCode: string }).errorCode).toBe(
				'completion_delivery_failed'
			);
			assertNoSecrets(result, secretNeedles(token, claim));
			assertNoSecrets(store.failures, secretNeedles(token, claim));
		});
	});

	describe('configuration validation', () => {
		it('rejects invalid public origin or sender configuration', () => {
			const store: FakeStore = new FakeStore();
			const cryptor: FakeCryptor = new FakeCryptor('skca1_dummy');
			const mail: FakeMail = new FakeMail();

			expect(
				() => new CompletionDeliveryService(store, cryptor, mail, 'http://insecure.example', SENDER)
			).toThrow(InvalidCompletionDeliveryConfigError);

			expect(
				() =>
					new CompletionDeliveryService(
						store,
						cryptor,
						mail,
						'https://signkit.example/subpath',
						SENDER
					)
			).toThrow(InvalidCompletionDeliveryConfigError);

			expect(
				() =>
					new CompletionDeliveryService(store, cryptor, mail, ORIGIN, {
						fromEmail: 'invalid-email',
						fromName: 'SignKit'
					})
			).toThrow(InvalidCompletionDeliveryConfigError);
		});
	});

	describe('concurrency bounding', () => {
		it('delivers a claimed batch with bounded concurrency (5)', async () => {
			const issued = await issueCompletionToken();
			const claims = await Promise.all(
				Array.from(
					{ length: 6 },
					async (_, index: number) =>
						(
							await eligibleClaim({
								token: issued.token,
								deliveryId: `delivery-${index + 1}`,
								recipientId: `recipient-${index + 1}`
							})
						).claim
				)
			);
			const store: FakeStore = new FakeStore();
			store.rows = claims;
			const mail: TrackingMail = new TrackingMail();
			const result = await service(
				store,
				new FakeCryptor(issued.token),
				mail
			).deliverPendingCompletions();

			expect(result.delivered).toBe(6);
			expect(mail.maximumActive).toBe(5);
			expect(mail.messages).toHaveLength(6);
		});
	});
});
