import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type {
	PublishRecipientViewedCommand,
	PublishedRecipientViewed,
	RecipientViewStore,
	ViewedPreparation
} from '$lib/ports/recipient-view-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';
import type { RecipientAccessApplicationPort } from './recipient-access';

const MAX_AUDIT_ATTEMPTS: number = 3;

export interface RecipientViewedInput {
	token: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
}

export type RecipientViewedResult =
	| { outcome: 'published' | 'replayed'; result: PublishedRecipientViewed }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface RecipientViewedApplicationPort {
	view(input: RecipientViewedInput): Promise<RecipientViewedResult>;
}

export class RecipientViewedApplication implements RecipientViewedApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly store: RecipientViewStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async view(input: RecipientViewedInput): Promise<RecipientViewedResult> {
		const before: RecipientSigningContext | null = await this.access.resolve(
			input.token,
			this.now().toISOString()
		);
		if (before === null) return { outcome: 'not_found' };
		if (
			before.envelopeId !== input.expectedEnvelopeId ||
			before.recipientId !== input.expectedRecipientId
		) {
			return { outcome: 'context_mismatch' };
		}

		const capabilityHash: string = await hashRecipientCapability(input.token);
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				envelopeId: before.envelopeId,
				recipientId: before.recipientId,
				capabilityHash
			})
		);
		const key = {
			organizationId: before.organizationId,
			envelopeId: before.envelopeId,
			recipientId: before.recipientId,
			capabilityHash,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};

		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const viewedAt: string = this.now().toISOString();
			const preparation: ViewedPreparation = await this.store.prepareViewed(key, viewedAt);
			if (preparation.outcome === 'replayed') {
				return await this.reauthorizeResult(input.token, before, {
					outcome: 'replayed',
					result: preparation.result
				});
			}
			if (preparation.outcome !== 'ready') return preparation;

			const auditEventId: string = await deterministicUuid(
				[
					'signkit-recipient-viewed-event-v1',
					before.organizationId,
					before.envelopeId,
					before.recipientId,
					input.idempotencyKey
				].join('\u0000')
			);
			const auditPayloadJson: string = JSON.stringify({
				recipientId: before.recipientId,
				role: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				viewedAt
			});
			const auditEventHash: string = await sha256(
				JSON.stringify({
					actorId: before.recipientId,
					envelopeId: before.envelopeId,
					eventType: 'recipient.viewed',
					occurredAt: viewedAt,
					organizationId: before.organizationId,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				})
			);
			const command: PublishRecipientViewedCommand = {
				...key,
				recipientRole: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				expectedSentCommitSha: preparation.sentCommitSha,
				updatedAt: viewedAt,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson
			};
			const published: RecipientViewedResult = await this.store.publishViewed(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			if (published.outcome === 'published' || published.outcome === 'replayed') {
				return await this.reauthorizeResult(input.token, before, published);
			}
			return published;
		}

		throw new Error('Recipient viewed retry loop exhausted without a terminal result');
	}

	private async reauthorizeResult(
		token: string,
		before: RecipientSigningContext,
		result: Extract<RecipientViewedResult, { outcome: 'published' | 'replayed' }>
	): Promise<RecipientViewedResult> {
		const after: RecipientSigningContext | null = await this.access.resolve(
			token,
			this.now().toISOString()
		);
		if (after === null) return { outcome: 'not_found' };
		if (!sameAuthorizationBoundary(before, after)) return { outcome: 'integrity_error' };
		return result;
	}
}

function sameAuthorizationBoundary(
	left: RecipientSigningContext,
	right: RecipientSigningContext
): boolean {
	return (
		left.organizationId === right.organizationId &&
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.sentRevision.commitSha === right.sentRevision.commitSha &&
		left.sentRevision.archiveKey === right.sentRevision.archiveKey &&
		left.sentRevision.archiveSha256 === right.sentRevision.archiveSha256
	);
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

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}
