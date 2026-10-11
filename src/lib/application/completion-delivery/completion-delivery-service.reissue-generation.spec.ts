import { describe, expect, it, vi } from 'vitest';
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
import { issueCompletionToken } from '$lib/security/completion-token';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import {
	CloudflareBindingMailSender,
	CloudflareRestMailSender
} from '$lib/adapters/mail/cloudflare-email';
import { NodemailerSmtpMailSender, type SmtpTransporter } from '$lib/adapters/mail/smtp';
import type { SmtpConfig } from '$lib/adapters/mail/smtp-config';
import { CompletionDeliveryService } from './completion-delivery-service';
import type { CompletionPdfAttachmentReaderPort } from './completion-pdf-attachment-reader';

/**
 * Exercises the real {@link NodemailerSmtpMailSender} and
 * {@link CloudflareBindingMailSender}/{@link CloudflareRestMailSender}
 * adapters -- not the generic `FakeMail` test double in
 * `completion-delivery-service.spec.ts` -- against a reissued completion
 * delivery generation, to prove the drain path treats a reissued generation
 * exactly like any other pending delivery: only the new grant's token ever
 * reaches a mail provider, and the predecessor it was chained from is never
 * referenced by any store call this drain makes. Store-level proof that the
 * predecessor row itself stays byte-identical after publish lives in
 * `postgres-completion-access-reissue.integration.spec.ts` and
 * `d1-completion-access-reissue.integration.spec.ts`; this file never touches
 * that table at all.
 */

const NOW: Date = new Date('2026-10-11T12:00:00.000Z');
const ORIGIN: string = 'https://signkit.example';
const SENDER = { fromEmail: 'noreply@signkit.example', fromName: 'SignKit' } as const;
const PREDECESSOR_DELIVERY_ID: string = 'predecessor-delivery-exhausted-1';
const SUCCESSOR_DELIVERY_ID: string = 'successor-delivery-generation-2';
const SEALING_KEY: string = btoa(
	String.fromCharCode(...Array.from({ length: 32 }, (_, index: number): number => index + 1))
);

class ReissueGenerationStore implements CompletionDeliveryStore {
	readonly completions: CompleteCompletionDeliveryCommand[] = [];
	readonly failures: FailCompletionDeliveryCommand[] = [];
	readonly reads: ReadClaimedCompletionDeliveryCommand[] = [];
	rows: ClaimedCompletionDelivery[] = [];
	completeResult: CompleteCompletionDeliveryResult = { outcome: 'completed' };
	failResult: FailCompletionDeliveryResult = { outcome: 'failed' };

	async discoverEligibleRecipients(): Promise<readonly EligibleCompletionDeliveryRecipient[]> {
		return [];
	}

	async enrollDeliveries(items: readonly EnrollCompletionDeliveryItem[]): Promise<number> {
		return items.length;
	}

	async claimPendingDeliveries(
		command: ClaimCompletionDeliveriesCommand
	): Promise<readonly ClaimedCompletionDelivery[]> {
		return this.rows.slice(0, command.limit);
	}

	async readClaimedDelivery(
		command: ReadClaimedCompletionDeliveryCommand
	): Promise<ClaimedCompletionDelivery | null> {
		this.reads.push(command);
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

/** Seals a real, freshly-issued completion token for the reissued successor generation. */
async function reissuedSuccessorClaim(): Promise<{
	claim: ClaimedCompletionDelivery;
	token: string;
}> {
	const sealer = new AesGcmCompletionTokenSealer(SEALING_KEY);
	const issued = await issueCompletionToken();
	const context = {
		envelopeId: 'envelope-1',
		recipientId: 'recipient-1',
		deliveryId: SUCCESSOR_DELIVERY_ID
	};
	const sealed = await sealer.seal(issued.token, context);
	return {
		token: issued.token,
		claim: {
			deliveryId: SUCCESSOR_DELIVERY_ID,
			envelopeId: 'envelope-1',
			recipientId: 'recipient-1',
			status: 'processing',
			recipientEmail: 'recipient@example.com',
			recipientName: 'Recipient One',
			recipientLocale: 'en',
			recipientRole: 'signer',
			envelopeTitle: 'Reissued Completion Agreement',
			envelopeStatus: 'completed',
			tokenHash: issued.tokenHash,
			accessExpiresAt: '2026-11-10T12:00:00.000Z',
			accessRevokedAt: null,
			sealedToken: sealed.sealedToken,
			sealedTokenSha256: sealed.sealedTokenSha256,
			sealingKeyId: sealed.sealingKeyId,
			availableAt: NOW.toISOString(),
			attempts: 0,
			lockedAt: NOW.toISOString()
		}
	};
}

function smtpSender(sendMail: ReturnType<typeof vi.fn>): NodemailerSmtpMailSender {
	const config: SmtpConfig = {
		host: 'smtp.example.com',
		port: 587,
		secure: false,
		auth: { user: 'relay-user', pass: 'relay-secret' }
	};
	return new NodemailerSmtpMailSender(config, () => ({ sendMail }) as unknown as SmtpTransporter);
}

/** A PDF well over the mail-attachment bound: the message still sends, with a secure-download link instead of an attachment. */
class OversizePdfAttachmentReader implements CompletionPdfAttachmentReaderPort {
	async read(): Promise<{ outcome: 'oversize'; byteSize: number }> {
		return { outcome: 'oversize', byteSize: 64 * 1024 * 1024 };
	}
}

describe('CompletionDeliveryService draining a reissued generation through the real SMTP adapter', () => {
	it('sends only the new token/grant, never any predecessor material, and completes exactly that delivery', async () => {
		const { claim, token } = await reissuedSuccessorClaim();
		const store = new ReissueGenerationStore();
		store.rows = [claim];
		const sendMail = vi.fn(async () => ({
			accepted: [claim.recipientEmail],
			rejected: [],
			messageId: '<reissued-1@smtp.example.com>'
		}));
		const service = new CompletionDeliveryService(
			store,
			new AesGcmCompletionTokenSealer(SEALING_KEY),
			smtpSender(sendMail),
			ORIGIN,
			SENDER,
			(): Date => NOW,
			(): string => 'claim-token-1',
			undefined,
			new OversizePdfAttachmentReader()
		);

		const result = await service.deliverPendingCompletions();
		expect(result.delivered).toBe(1);
		expect(sendMail).toHaveBeenCalledTimes(1);
		const sentCall = sendMail.mock.calls[0] as unknown as [{ text: string; html: string }];
		const sentMessage = sentCall[0];
		expect(sentMessage.text).toContain(token);
		expect(sentMessage.text).not.toContain(PREDECESSOR_DELIVERY_ID);
		expect(sentMessage.html).not.toContain(PREDECESSOR_DELIVERY_ID);

		expect(store.completions).toHaveLength(1);
		expect(store.completions[0].deliveryId).toBe(SUCCESSOR_DELIVERY_ID);
		expect(store.completions[0].deliveryId).not.toBe(PREDECESSOR_DELIVERY_ID);
		expect(store.failures).toHaveLength(0);
	});

	it('fails closed on a real SMTP permanent rejection without losing or reviving the predecessor', async () => {
		const { claim } = await reissuedSuccessorClaim();
		const store = new ReissueGenerationStore();
		store.rows = [claim];
		const permanentRejection = Object.assign(new Error('mailbox unavailable'), {
			command: 'RCPT TO',
			responseCode: 550,
			rejected: [claim.recipientEmail]
		});
		const sendMail = vi.fn(async () => {
			throw permanentRejection;
		});
		const service = new CompletionDeliveryService(
			store,
			new AesGcmCompletionTokenSealer(SEALING_KEY),
			smtpSender(sendMail),
			ORIGIN,
			SENDER,
			(): Date => NOW,
			(): string => 'claim-token-1',
			undefined,
			new OversizePdfAttachmentReader()
		);

		const result = await service.deliverPendingCompletions();
		expect(result.permanentlyFailed).toBe(1);
		expect(store.failures).toHaveLength(1);
		expect(store.failures[0].deliveryId).toBe(SUCCESSOR_DELIVERY_ID);
		expect(store.failures[0].retryable).toBe(false);
		expect(store.completions).toHaveLength(0);
		// The predecessor this generation was chained from is never named by
		// any call this drain makes -- the drain has no notion of "revive".
		const serializedCalls = JSON.stringify([
			...store.completions,
			...store.failures,
			...store.reads
		]);
		expect(serializedCalls).not.toContain(PREDECESSOR_DELIVERY_ID);
	});
});

describe('CompletionDeliveryService draining a reissued generation through the real Cloudflare adapters', () => {
	it('sends only the new token/grant through the Workers email binding', async () => {
		const { claim, token } = await reissuedSuccessorClaim();
		const store = new ReissueGenerationStore();
		store.rows = [claim];
		const send = vi.fn(async () => ({ messageId: '<reissued-1@email.cloudflare.net>' }));
		const service = new CompletionDeliveryService(
			store,
			new AesGcmCompletionTokenSealer(SEALING_KEY),
			new CloudflareBindingMailSender({ send } as unknown as ConstructorParameters<
				typeof CloudflareBindingMailSender
			>[0]),
			ORIGIN,
			SENDER,
			(): Date => NOW,
			(): string => 'claim-token-1',
			undefined,
			new OversizePdfAttachmentReader()
		);

		const result = await service.deliverPendingCompletions();
		expect(result.delivered).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);
		const sentCall = send.mock.calls[0] as unknown as [{ text: string }];
		const sentMessage = sentCall[0];
		expect(sentMessage.text).toContain(token);
		expect(sentMessage.text).not.toContain(PREDECESSOR_DELIVERY_ID);
		expect(store.completions).toHaveLength(1);
		expect(store.completions[0].deliveryId).toBe(SUCCESSOR_DELIVERY_ID);
	});

	it('fails closed on a real Cloudflare REST transport failure without losing or reviving the predecessor', async () => {
		const { claim } = await reissuedSuccessorClaim();
		const store = new ReissueGenerationStore();
		store.rows = [claim];
		const fetchFn = vi.fn(async () => {
			throw new TypeError('network unavailable');
		});
		const service = new CompletionDeliveryService(
			store,
			new AesGcmCompletionTokenSealer(SEALING_KEY),
			new CloudflareRestMailSender('a'.repeat(32), 'rest-api-token', fetchFn),
			ORIGIN,
			SENDER,
			(): Date => NOW,
			(): string => 'claim-token-1',
			undefined,
			new OversizePdfAttachmentReader()
		);

		const result = await service.deliverPendingCompletions();
		expect(result.retryableFailed).toBe(1);
		expect(store.failures).toHaveLength(1);
		expect(store.failures[0].deliveryId).toBe(SUCCESSOR_DELIVERY_ID);
		expect(store.failures[0].retryable).toBe(true);
		expect(store.completions).toHaveLength(0);
		const serializedCalls = JSON.stringify([
			...store.completions,
			...store.failures,
			...store.reads
		]);
		expect(serializedCalls).not.toContain(PREDECESSOR_DELIVERY_ID);
	});
});
