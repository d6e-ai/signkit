import { describe, expect, it } from 'vitest';
import type {
	ClaimedInvitationDelivery,
	ClaimInvitationDeliveriesCommand,
	CompleteInvitationDeliveryCommand,
	CompleteInvitationDeliveryResult,
	DeliveryOutboxStore,
	FailInvitationDeliveryCommand,
	FailInvitationDeliveryResult,
	ReadClaimedInvitationCommand
} from '$lib/ports/delivery-outbox-store';
import {
	MailDeliveryError,
	type MailMessage,
	type MailSendReceipt,
	type MailSender
} from '$lib/ports/mail-sender';
import {
	AesGcmRecipientCapabilitySealer,
	type CapabilitySealContext
} from '$lib/security/delivery-capability';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import {
	hashRecipientCapability,
	issueRecipientCapability
} from '$lib/security/recipient-capability';
import { OPAQUE_TOKEN_PATTERN } from '$lib/security/opaque-token';
import {
	INVITATION_CLAIM_LEASE_MS,
	INVITATION_RETRY_BASE_DELAY_MS,
	InvitationDeliveryService,
	invitationRetryAvailableAt,
	MAX_INVITATION_DELIVERY_ATTEMPTS,
	type RecipientCapabilityOpener
} from './delivery-service';

const NOW: Date = new Date('2026-09-12T00:00:00.000Z');
const ORIGIN: string = 'https://signkit.example';
const SENDER = { fromEmail: 'noreply@signkit.example', fromName: 'SignKit' } as const;
const CLAIM_TOKEN: string = 'lease-opaque-claim-token-0001';
const SEALING_KEY: string = btoa(
	String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + 1))
);

class FakeStore implements DeliveryOutboxStore {
	readonly claims: ClaimInvitationDeliveriesCommand[] = [];
	readonly completions: CompleteInvitationDeliveryCommand[] = [];
	readonly failures: FailInvitationDeliveryCommand[] = [];
	readonly reads: ReadClaimedInvitationCommand[] = [];
	rows: ClaimedInvitationDelivery[] = [];
	readResult: ClaimedInvitationDelivery | null | undefined;
	readErrors: ReadonlySet<string> = new Set();
	completeResult: CompleteInvitationDeliveryResult = { outcome: 'completed' };
	failResult: FailInvitationDeliveryResult = { outcome: 'failed' };

	async claimPendingInvitations(
		command: ClaimInvitationDeliveriesCommand
	): Promise<readonly ClaimedInvitationDelivery[]> {
		this.claims.push(command);
		return this.rows.slice(0, command.limit);
	}

	async completeInvitationDelivery(
		command: CompleteInvitationDeliveryCommand
	): Promise<CompleteInvitationDeliveryResult> {
		this.completions.push(command);
		return this.completeResult;
	}

	async readClaimedInvitation(
		command: ReadClaimedInvitationCommand
	): Promise<ClaimedInvitationDelivery | null> {
		this.reads.push(command);
		if (this.readErrors.has(command.deliveryId)) throw new Error('database unavailable');
		if (this.readResult !== undefined) return this.readResult;
		return (
			this.rows.find(
				(row: ClaimedInvitationDelivery): boolean =>
					row.organizationId === command.organizationId && row.deliveryId === command.deliveryId
			) ?? null
		);
	}

	async failInvitationDelivery(
		command: FailInvitationDeliveryCommand
	): Promise<FailInvitationDeliveryResult> {
		this.failures.push(command);
		return this.failResult;
	}

	async findStaleSealedCapabilities(): Promise<[]> {
		return [];
	}

	async resealCapability(): Promise<{ outcome: 'stale' }> {
		return { outcome: 'stale' };
	}
}

class FakeOpener implements RecipientCapabilityOpener {
	readonly openCalls: { sealed: string; context: CapabilitySealContext; sealingKeyId: string }[] =
		[];
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

	async open(
		sealedCapability: string,
		context: CapabilitySealContext,
		sealingKeyId: string
	): Promise<string> {
		this.openCalls.push({ sealed: sealedCapability, context, sealingKeyId });
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
	opener: RecipientCapabilityOpener,
	mail: FakeMail
): InvitationDeliveryService {
	return new InvitationDeliveryService(
		store,
		opener,
		mail,
		ORIGIN,
		SENDER,
		(): Date => NOW,
		(): string => CLAIM_TOKEN
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
	overrides: Partial<ClaimedInvitationDelivery> & { token?: string } = {}
): Promise<{
	claim: ClaimedInvitationDelivery;
	token: string;
}> {
	const issued = await issueRecipientCapability();
	const { token: requestedToken, ...claimOverrides } = overrides;
	const token: string = requestedToken ?? issued.token;
	const sealedCapability: string = claimOverrides.sealedCapability ?? 'skdc1_test-ciphertext';
	const sealedCapabilitySha256: string =
		claimOverrides.sealedCapabilitySha256 ?? (await sha256Hex(sealedCapability));
	const capabilityHash: string =
		claimOverrides.capabilityHash ??
		(requestedToken === undefined
			? issued.tokenHash
			: await hashRecipientCapability(requestedToken));
	return {
		token,
		claim: {
			deliveryId: 'delivery-1',
			organizationId: 'org-1',
			envelopeId: 'envelope-1',
			recipientId: 'recipient-1',
			kind: 'recipient_invitation',
			status: 'processing',
			recipientEmail: 'alex@example.com',
			recipientName: 'Alex',
			recipientLocale: 'en',
			recipientStatus: 'pending',
			envelopeTitle: 'Service Agreement',
			envelopeStatus: 'sent',
			capabilityHash,
			capabilityExpiresAt: '2026-09-26T00:00:00.000Z',
			reservedCapabilityExpiresAt: '2026-09-26T00:00:00.000Z',
			capabilityRevokedAt: null,
			sealedCapability,
			sealedCapabilitySha256,
			sealingKeyId: 'key-1',
			availableAt: '2026-09-11T23:00:00.000Z',
			attempts: 1,
			lockedAt: NOW.toISOString(),
			...claimOverrides
		}
	};
}

function secretNeedles(token: string, claim: ClaimedInvitationDelivery): readonly string[] {
	return [
		token,
		claim.recipientEmail,
		claim.recipientName,
		claim.sealedCapability ?? 'skdc1_',
		'/s/',
		'skr1_',
		'skdc1_'
	];
}

function assertNoSecrets(value: unknown, needles: readonly string[]): void {
	const encoded: string = JSON.stringify(value);
	for (const needle of needles) {
		if (needle.length === 0) continue;
		expect(encoded).not.toContain(needle);
	}
}

describe('InvitationDeliveryService', () => {
	it('mints an opaque lease claim token by default, not a UUIDv7', async () => {
		const store: FakeStore = new FakeStore();

		await new InvitationDeliveryService(
			store,
			new FakeOpener('unused'),
			new FakeMail(),
			ORIGIN,
			SENDER,
			(): Date => NOW
		).deliverPendingInvitations();

		expect(store.claims).toHaveLength(1);
		expect(store.claims[0].claimToken).toMatch(OPAQUE_TOKEN_PATTERN);
		expect(store.claims[0].claimToken).not.toMatch(UUID_V7_PATTERN);
	});

	it('does not decrypt or send when the claim is no longer current at the send boundary', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		store.readResult = null;
		const opener: FakeOpener = new FakeOpener(token);
		const mail: FakeMail = new FakeMail();

		const result = await service(store, opener, mail).deliverPendingInvitations();

		expect(result).toMatchObject({ claimed: 1, delivered: 0, stale: 1 });
		expect(result.outcomes).toEqual([{ deliveryId: 'delivery-1', outcome: 'stale' }]);
		expect(store.reads).toEqual([
			{
				organizationId: 'org-1',
				deliveryId: 'delivery-1',
				claimToken: CLAIM_TOKEN
			}
		]);
		expect(opener.keyLookups).toBe(0);
		expect(opener.openCalls).toHaveLength(0);
		expect(mail.messages).toHaveLength(0);
		expect(store.completions).toHaveLength(0);
		expect(store.failures).toHaveLength(0);
	});

	it('uses the refreshed recipient state and permanently scrubs a recipient that changed after claim', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		store.readResult = { ...claim, recipientStatus: 'viewed' };
		const opener: FakeOpener = new FakeOpener(token);
		const mail: FakeMail = new FakeMail();

		const result = await service(store, opener, mail).deliverPendingInvitations();

		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'integrity_failed',
				errorCode: 'recipient_not_active'
			}
		]);
		expect(store.failures[0]).toMatchObject({
			errorCode: 'recipient_not_active',
			retryable: false,
			nextAvailableAt: NOW.toISOString()
		});
		expect(opener.keyLookups).toBe(0);
		expect(opener.openCalls).toHaveLength(0);
		expect(mail.messages).toHaveLength(0);
	});

	it('claims a bounded batch, verifies the sealed capability, and completes after provider acceptance', async () => {
		const issued = await issueRecipientCapability();
		const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
			SEALING_KEY
		);
		const context: CapabilitySealContext = {
			organizationId: 'org-1',
			envelopeId: 'envelope-1',
			recipientId: 'recipient-1',
			deliveryId: 'delivery-1'
		};
		const sealed = await sealer.seal(issued.token, context);
		const { claim } = await eligibleClaim({
			token: issued.token,
			capabilityHash: issued.tokenHash,
			sealedCapability: sealed.sealedCapability,
			sealedCapabilitySha256: sealed.sealedCapabilitySha256,
			sealingKeyId: sealed.sealingKeyId
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: RecipientCapabilityOpener = {
			currentSealingKeyId: async (): Promise<string> => sealed.sealingKeyId,
			isKnownSealingKeyId: async (keyId: string): Promise<boolean> => keyId === sealed.sealingKeyId,
			open: (
				sealedCapability: string,
				seal: CapabilitySealContext,
				sealingKeyId: string
			): Promise<string> => sealer.open(sealedCapability, seal, sealingKeyId)
		};
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations(99);

		expect(store.claims).toEqual([
			{
				claimToken: CLAIM_TOKEN,
				claimedAt: NOW.toISOString(),
				staleBefore: new Date(NOW.valueOf() - INVITATION_CLAIM_LEASE_MS).toISOString(),
				limit: 25
			}
		]);
		expect(result).toEqual({
			claimed: 1,
			delivered: 1,
			retryableFailed: 0,
			permanentlyFailed: 0,
			integrityFailed: 0,
			stale: 0,
			outcomes: [{ deliveryId: 'delivery-1', outcome: 'delivered' }]
		});
		expect(store.completions).toEqual([
			{
				organizationId: 'org-1',
				deliveryId: 'delivery-1',
				claimToken: CLAIM_TOKEN,
				deliveredAt: NOW.toISOString(),
				providerMessageId: 'provider-1'
			}
		]);
		expect(mail.messages).toHaveLength(1);
		expect(mail.messages[0].to).toBe('alex@example.com');
		expect(mail.messages[0].from).toEqual({
			email: SENDER.fromEmail,
			name: SENDER.fromName
		});
		expect(mail.messages[0].subject).toBe('Please review "Service Agreement"');
		expect(mail.messages[0].text).toContain('Hello Alex,');
		expect(mail.messages[0].text).toContain(`https://signkit.example/s/${issued.token}`);
		expect(mail.messages[0].html).toContain('lang="en"');
		expect(mail.messages[0].html).toContain(`href="https://signkit.example/s/${issued.token}"`);
		expect(mail.messages[0].deliveryKey).toBe('signkit-invitation-v1:org-1:delivery-1');
		assertNoSecrets(result, secretNeedles(issued.token, claim));
		assertNoSecrets(store.completions, secretNeedles(issued.token, claim));
	});

	it('renders Japanese invitation copy for ja recipients', async () => {
		const { claim, token } = await eligibleClaim({
			recipientLocale: 'ja',
			recipientName: '佐藤',
			envelopeTitle: '業務委託契約'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(token);
		const mail: FakeMail = new FakeMail();
		await service(store, opener, mail).deliverPendingInvitations();
		expect(mail.messages[0].subject).toBe('「業務委託契約」の確認をお願いします');
		expect(mail.messages[0].text).toContain('佐藤 様');
		expect(mail.messages[0].html).toContain('lang="ja"');
		expect(mail.messages[0].html).toContain('契約書を開く');
		expect(mail.messages[0].html).not.toContain('合意書');
		expect(mail.messages[0].text).not.toContain('合意書');
		expect(mail.messages[0].html).toContain('#ca3500');
		expect(mail.messages[0].html).toContain('role="presentation"');
		expect(opener.openCalls[0]?.context).toEqual({
			organizationId: 'org-1',
			envelopeId: 'envelope-1',
			recipientId: 'recipient-1',
			deliveryId: 'delivery-1'
		});
	});

	it('localizes invitation copy from stored recipientLocale, never the mailbox', async () => {
		const japaneseMailbox = await eligibleClaim({
			recipientLocale: 'ja',
			recipientEmail: 'alex@example.com',
			recipientName: 'Alex'
		});
		const englishMailbox = await eligibleClaim({
			recipientLocale: 'en',
			recipientEmail: 'sato@example.co.jp',
			recipientName: '佐藤',
			deliveryId: 'delivery-2',
			recipientId: 'recipient-2'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [japaneseMailbox.claim];
		const jaMail: FakeMail = new FakeMail();
		await service(store, new FakeOpener(japaneseMailbox.token), jaMail).deliverPendingInvitations();
		expect(jaMail.messages[0].html).toContain('lang="ja"');
		expect(jaMail.messages[0].html).toContain('契約書を開く');
		expect(jaMail.messages[0].html).not.toContain('Open the agreement');

		store.rows = [englishMailbox.claim];
		const enMail: FakeMail = new FakeMail();
		await service(store, new FakeOpener(englishMailbox.token), enMail).deliverPendingInvitations();
		expect(enMail.messages[0].html).toContain('lang="en"');
		expect(enMail.messages[0].html).toContain('Open the agreement');
		expect(enMail.messages[0].html).not.toContain('契約書を開く');
	});

	it('delivers a claimed batch with bounded concurrency so leases do not idle sequentially', async () => {
		const issued = await issueRecipientCapability();
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
			new FakeOpener(issued.token),
			mail
		).deliverPendingInvitations();

		expect(result.delivered).toBe(6);
		expect(mail.maximumActive).toBe(5);
		expect(mail.messages).toHaveLength(6);
	});

	it('isolates a per-item store failure so sibling claims still complete', async () => {
		const issued = await issueRecipientCapability();
		const first = await eligibleClaim({
			token: issued.token,
			deliveryId: 'delivery-1',
			recipientId: 'recipient-1'
		});
		const second = await eligibleClaim({
			token: issued.token,
			deliveryId: 'delivery-2',
			recipientId: 'recipient-2'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [first.claim, second.claim];
		store.readErrors = new Set(['delivery-1']);
		const mail: FakeMail = new FakeMail();

		const result = await service(
			store,
			new FakeOpener(issued.token),
			mail
		).deliverPendingInvitations();

		expect(result).toMatchObject({ claimed: 2, delivered: 1, retryableFailed: 1 });
		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'retryable_failed',
				errorCode: 'delivery_store_unavailable'
			},
			{ deliveryId: 'delivery-2', outcome: 'delivered' }
		]);
		expect(mail.messages).toHaveLength(1);
		expect(mail.messages[0].deliveryKey).toContain('delivery-2');
		expect(store.completions).toHaveLength(1);
	});

	it('HTML-escapes recipient name and envelope title', async () => {
		const { claim, token } = await eligibleClaim({
			recipientName: `<img src=x onerror=alert(1)>`,
			envelopeTitle: `<script>alert(1)</script>`
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		const html: string = mail.messages[0].html;
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<img');
		assertNoSecrets(result, [token, claim.recipientEmail, '<script>', '<img']);
	});

	it('fails ciphertext digest mismatches without sending mail or opening the seal', async () => {
		const { claim, token } = await eligibleClaim({
			sealedCapabilitySha256: 'a'.repeat(64)
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(token);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();
		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'integrity_failed',
				errorCode: 'ciphertext_digest_mismatch'
			}
		]);
		expect(mail.messages).toHaveLength(0);
		expect(opener.openCalls).toHaveLength(0);
		expect(opener.keyLookups).toBe(0);
		expect(store.failures[0]).toMatchObject({
			organizationId: 'org-1',
			deliveryId: 'delivery-1',
			claimToken: CLAIM_TOKEN,
			errorCode: 'ciphertext_digest_mismatch',
			nextAvailableAt: NOW.toISOString(),
			retryable: false
		});
		assertNoSecrets(result, secretNeedles(token, claim));
	});

	it('retries a sealing key mismatch without opening or scrubbing ciphertext', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(token);
		opener.currentKeyId = 'other-key';
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'retryable_failed',
			errorCode: 'sealing_key_mismatch'
		});
		expect(mail.messages).toHaveLength(0);
		expect(opener.openCalls).toHaveLength(0);
		expect(store.failures[0]).toMatchObject({
			nextAvailableAt: new Date(NOW.valueOf() + INVITATION_RETRY_BASE_DELAY_MS).toISOString(),
			retryable: true
		});
	});

	it('fails a plaintext capability hash mismatch after authenticated open', async () => {
		const { claim } = await eligibleClaim();
		const other = await issueRecipientCapability();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(other.token);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'integrity_failed',
			errorCode: 'capability_hash_mismatch'
		});
		expect(mail.messages).toHaveLength(0);
		expect(opener.openCalls).toHaveLength(1);
		assertNoSecrets(result, [other.token, claim.recipientEmail]);
	});

	it('treats opener authentication failure as a nonretryable integrity error', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(token);
		opener.throwOnOpen = true;
		opener.openError = new Error(`auth failed for ${token} ${claim.recipientEmail}`);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'integrity_failed',
			errorCode: 'capability_open_failed'
		});
		expect(mail.messages).toHaveLength(0);
		assertNoSecrets(result, secretNeedles(token, claim));
		assertNoSecrets(store.failures, secretNeedles(token, claim));
	});

	it('refuses inactive envelopes and recipients before touching mail', async () => {
		const completedEnvelope = await eligibleClaim({ envelopeStatus: 'completed' });
		const declinedRecipient = await eligibleClaim({
			deliveryId: 'delivery-2',
			recipientStatus: 'declined'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [completedEnvelope.claim, declinedRecipient.claim];
		const opener: FakeOpener = new FakeOpener(completedEnvelope.token);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();
		expect(result.integrityFailed).toBe(2);
		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'integrity_failed',
				errorCode: 'envelope_not_active'
			},
			{
				deliveryId: 'delivery-2',
				outcome: 'integrity_failed',
				errorCode: 'recipient_not_active'
			}
		]);
		expect(mail.messages).toHaveLength(0);
		expect(opener.openCalls).toHaveLength(0);
	});

	it('fails expired or revoked capabilities without sending mail', async () => {
		const expired = await eligibleClaim({ capabilityExpiresAt: NOW.toISOString() });
		const revoked = await eligibleClaim({
			deliveryId: 'delivery-2',
			capabilityRevokedAt: '2026-09-11T12:00:00.000Z'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [expired.claim, revoked.claim];
		const mail: FakeMail = new FakeMail();
		const result = await service(
			store,
			new FakeOpener(expired.token),
			mail
		).deliverPendingInvitations();
		expect(
			result.outcomes.map((item) => item.outcome === 'integrity_failed' && item.errorCode)
		).toEqual(['capability_expired', 'capability_revoked']);
		expect(mail.messages).toHaveLength(0);
		expect(store.failures.map((failure) => failure.nextAvailableAt)).toEqual([
			NOW.toISOString(),
			NOW.toISOString()
		]);
		expect(store.failures.map((failure) => failure.retryable)).toEqual([false, false]);
	});

	it('schedules deterministic capped exponential backoff for retryable mail failures', async () => {
		const { claim, token } = await eligibleClaim({ attempts: 4 });
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.error = new MailDeliveryError('provider_timeout', true);
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'retryable_failed',
			errorCode: 'provider_timeout'
		});
		expect(store.failures[0].nextAvailableAt).toBe(invitationRetryAvailableAt(NOW, 4));
		expect(store.failures[0].nextAvailableAt).toBe(
			new Date(NOW.valueOf() + INVITATION_RETRY_BASE_DELAY_MS * 8).toISOString()
		);
		expect(store.completions).toHaveLength(0);
	});

	it('caps retry delay and marks permanent mail failure as terminal', async () => {
		expect(invitationRetryAvailableAt(NOW, 20)).toBe(
			new Date(NOW.valueOf() + 6 * 60 * 60 * 1000).toISOString()
		);
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.error = new MailDeliveryError('mailbox_unavailable', false);
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		expect(result.permanentlyFailed).toBe(1);
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'permanently_failed',
			errorCode: 'mailbox_unavailable'
		});
		expect(store.failures[0]).toMatchObject({
			nextAvailableAt: NOW.toISOString(),
			retryable: false
		});
	});

	it('turns a retryable provider failure terminal at the bounded attempt limit', async () => {
		const { claim, token } = await eligibleClaim({ attempts: MAX_INVITATION_DELIVERY_ATTEMPTS });
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.error = new MailDeliveryError('provider_timeout', true);
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();

		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'permanently_failed',
			errorCode: 'delivery_attempts_exhausted'
		});
		expect(store.failures[0]).toMatchObject({
			errorCode: 'delivery_attempts_exhausted',
			retryable: false,
			nextAvailableAt: NOW.toISOString()
		});
	});

	it('records a stale claim when completion no longer matches the lease', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		store.completeResult = { outcome: 'stale' };
		const mail: FakeMail = new FakeMail();
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		expect(mail.messages).toHaveLength(1);
		expect(result).toMatchObject({
			claimed: 1,
			delivered: 0,
			stale: 1,
			outcomes: [{ deliveryId: 'delivery-1', outcome: 'stale' }]
		});
		assertNoSecrets(result, secretNeedles(token, claim));
	});

	it('does not leak provider PII from mail errors into the batch result', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.error = new MailDeliveryError(`550 user=${claim.recipientEmail} token=${token}`, true);
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		expect(result.outcomes[0]).toEqual({
			deliveryId: 'delivery-1',
			outcome: 'retryable_failed',
			errorCode: 'mail_delivery_failed'
		});
		assertNoSecrets(result, secretNeedles(token, claim));
		assertNoSecrets(store.failures, secretNeedles(token, claim));
		expect(store.failures[0].errorCode).toBe('mail_delivery_failed');
	});

	it('completes a queued provider receipt using the stable receipt identifier', async () => {
		const { claim, token } = await eligibleClaim({
			envelopeStatus: 'in_progress'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.receipt = { outcome: 'queued', receiptId: 'queue:abc_1' };
		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();
		expect(result.delivered).toBe(1);
		expect(store.completions[0].providerMessageId).toBe('queue:abc_1');
	});

	it('completes an accepted RFC 5322-style provider message ID without retrying the send', async () => {
		const { claim, token } = await eligibleClaim();
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const mail: FakeMail = new FakeMail();
		mail.receipt = {
			outcome: 'accepted',
			providerMessageId: '<01900000-0000-7000-8000-000000000001@email.cloudflare.net>'
		};

		const result = await service(store, new FakeOpener(token), mail).deliverPendingInvitations();

		expect(result.delivered).toBe(1);
		expect(result.retryableFailed).toBe(0);
		expect(store.completions[0].providerMessageId).toBe(
			'<01900000-0000-7000-8000-000000000001@email.cloudflare.net>'
		);
		expect(store.failures).toHaveLength(0);
	});

	it('rejects viewed recipients and reserved expiry mismatches before opening ciphertext', async () => {
		const viewed = await eligibleClaim({ recipientStatus: 'viewed' });
		const mismatched = await eligibleClaim({
			deliveryId: 'delivery-2',
			reservedCapabilityExpiresAt: '2026-09-27T00:00:00.000Z'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [viewed.claim, mismatched.claim];
		const opener: FakeOpener = new FakeOpener(viewed.token);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();

		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'integrity_failed',
				errorCode: 'recipient_not_active'
			},
			{
				deliveryId: 'delivery-2',
				outcome: 'integrity_failed',
				errorCode: 'capability_expiry_mismatch'
			}
		]);
		expect(opener.openCalls).toHaveLength(0);
		expect(mail.messages).toHaveLength(0);
	});

	it('rejects a corrupted recipient mailbox before passing it to the provider', async () => {
		const { claim, token } = await eligibleClaim({
			recipientEmail: 'recipient@example.com\r\nBcc: victim@example.com'
		});
		const store: FakeStore = new FakeStore();
		store.rows = [claim];
		const opener: FakeOpener = new FakeOpener(token);
		const mail: FakeMail = new FakeMail();
		const result = await service(store, opener, mail).deliverPendingInvitations();

		expect(result.outcomes).toEqual([
			{
				deliveryId: 'delivery-1',
				outcome: 'integrity_failed',
				errorCode: 'recipient_email_invalid'
			}
		]);
		expect(opener.openCalls).toHaveLength(0);
		expect(mail.messages).toHaveLength(0);
	});

	it('rejects non-root public origins and mail header control characters', () => {
		const store: FakeStore = new FakeStore();
		const opener: FakeOpener = new FakeOpener('unused');
		const mail: FakeMail = new FakeMail();

		expect(
			() =>
				new InvitationDeliveryService(store, opener, mail, 'https://signkit.example/base', SENDER)
		).toThrow('Invitation delivery configuration is invalid');
		expect(
			() =>
				new InvitationDeliveryService(store, opener, mail, ORIGIN, {
					fromEmail: 'noreply@signkit.example\r\nBcc: victim@example.com',
					fromName: 'SignKit'
				})
		).toThrow('Invitation delivery configuration is invalid');
	});
});
