import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	DeclineCommandKey,
	DeclinePreparation,
	PublishRecipientDeclinedCommand,
	PublishRecipientDeclinedResult,
	PublishedRecipientDeclined,
	RecipientDeclineStore
} from '$lib/ports/recipient-decline-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';

const MAX_AUDIT_ATTEMPTS: number = 3;

export interface RecipientDeclinedInput {
	token: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
}

export type RecipientDeclinedResult =
	| { outcome: 'published' | 'replayed'; result: PublishedRecipientDeclined }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'integrity_error' };

export interface RecipientDeclinedApplicationPort {
	decline(input: RecipientDeclinedInput): Promise<RecipientDeclinedResult>;
}

export class RecipientDeclinedApplication implements RecipientDeclinedApplicationPort {
	constructor(
		private readonly store: RecipientDeclineStore,
		private readonly now: () => Date = (): Date => new Date(),
		private readonly newId: UuidV7Generator = newUuidV7
	) {}

	async decline(input: RecipientDeclinedInput): Promise<RecipientDeclinedResult> {
		const capabilityHash: string = await hashRecipientCapability(input.token);
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				envelopeId: input.expectedEnvelopeId,
				recipientId: input.expectedRecipientId,
				capabilityHash
			})
		);
		const key: DeclineCommandKey = {
			capabilityHash,
			expectedEnvelopeId: input.expectedEnvelopeId,
			expectedRecipientId: input.expectedRecipientId,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};

		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const declinedAt: string = this.now().toISOString();
			const preparation: DeclinePreparation = await this.store.prepareDeclined(key, declinedAt);
			if (preparation.outcome !== 'ready') return preparation;

			// Replay is proven by the durable command receipt and its audit
			// evidence, not by re-deriving this identifier, so each attempt mints a
			// fresh one.
			const auditEventId: string = this.newId();
			const auditPayloadJson: string = JSON.stringify({
				recipientId: preparation.recipientId,
				role: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				declinedAt,
				revokedCapabilities: {
					reason: 'envelope_declined',
					recipientIds: preparation.revokedRecipientIds
				}
			});
			const auditEventHash: string = await sha256(
				JSON.stringify({
					actorId: preparation.recipientId,
					envelopeId: preparation.envelopeId,
					eventType: 'recipient.declined',
					occurredAt: declinedAt,
					organizationId: preparation.organizationId,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				})
			);
			const command: PublishRecipientDeclinedCommand = {
				...key,
				recipientRole: preparation.recipientRole,
				routingOrder: preparation.routingOrder,
				expectedSentCommitSha: preparation.sentCommitSha,
				updatedAt: declinedAt,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson,
				revocationEvidenceVersion: 2,
				revokedRecipientIds: preparation.revokedRecipientIds
			};
			const published: PublishRecipientDeclinedResult = await this.store.publishDeclined(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			return published;
		}

		throw new Error('Recipient declined retry loop exhausted without a terminal result');
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
