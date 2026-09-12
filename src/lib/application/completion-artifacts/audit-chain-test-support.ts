import type { CompletionEvidenceAuditEvent } from '$lib/ports/completion-artifact-store';
import { auditEventHashPreimage, type CompletionAuditChainContext } from './audit-event-integrity';
import { sha256TextHex } from './completion-manifest';

export interface AuditChainStep {
	id: string;
	eventType: string;
	actorType: string;
	actorId: string | null;
	occurredAt: string;
	payload: unknown;
}

/**
 * Builds a real, hash-verified `CompletionEvidenceAuditEvent[]` chain for
 * tests, using the exact production preimage function so a fixture can never
 * silently drift from what the real writers (and the real verifier) do.
 * Tampering tests should start from this and then mutate exactly one field.
 */
export async function buildVerifiedAuditChain(
	context: CompletionAuditChainContext,
	steps: readonly AuditChainStep[]
): Promise<CompletionEvidenceAuditEvent[]> {
	const events: CompletionEvidenceAuditEvent[] = [];
	let previousHash: string | null = null;
	for (let index = 0; index < steps.length; index += 1) {
		const step: AuditChainStep = steps[index];
		const payloadJson: string = JSON.stringify(step.payload);
		const draft: CompletionEvidenceAuditEvent = {
			id: step.id,
			sequence: index + 1,
			eventType: step.eventType,
			actorType: step.actorType,
			actorId: step.actorId,
			payloadJson,
			previousHash,
			eventHash: '',
			occurredAt: step.occurredAt
		};
		const preimage: string = auditEventHashPreimage(draft, step.payload, context);
		const eventHash: string = await sha256TextHex(preimage);
		const finished: CompletionEvidenceAuditEvent = { ...draft, eventHash };
		events.push(finished);
		previousHash = eventHash;
	}
	return events;
}
