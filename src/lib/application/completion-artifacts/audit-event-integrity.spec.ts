import { describe, expect, it } from 'vitest';
import {
	CompletionArtifactBoundExceededError,
	CompletionArtifactIntegrityError
} from '$lib/ports/completion-artifact-store';
import { buildVerifiedAuditChain, type AuditChainStep } from './audit-chain-test-support';
import {
	auditEventHashPreimage,
	verifyAuditEventRecord,
	verifyCompletionAuditChain
} from './audit-event-integrity';

const CONTEXT = { organizationId: 'org-1', envelopeId: 'envelope-1' };

function steps(count: number): AuditChainStep[] {
	const built: AuditChainStep[] = [];
	for (let sequence = 1; sequence <= count; sequence += 1) {
		const isLast: boolean = sequence === count;
		built.push({
			id: `audit-event-${sequence}`,
			eventType: isLast ? 'envelope.completed' : 'envelope.created',
			actorType: isLast ? 'recipient' : 'user',
			actorId: isLast ? 'recipient-1' : 'user-1',
			occurredAt: `2026-09-1${(sequence % 9) + 1}T00:00:00.000Z`,
			payload: isLast
				? {
						sentCommitSha: 'a'.repeat(40),
						completedAt: `2026-09-1${(sequence % 9) + 1}T00:00:00.000Z`
					}
				: { title: `Step ${sequence}` }
		});
	}
	return built;
}

describe('verifyCompletionAuditChain', () => {
	it('recomputes every event hash and verifies the chain through the envelope.completed anchor', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(3));
		const { proof, payloadsByEventId } = await verifyCompletionAuditChain(events, CONTEXT, 5_000);
		expect(proof).toEqual({
			anchorEventType: 'envelope.completed',
			anchorEventId: 'audit-event-3',
			headSequence: 3,
			verifiedEventCount: 3,
			hashChainVerified: true
		});
		expect(payloadsByEventId.get('audit-event-1')).toEqual({ title: 'Step 1' });
	});

	it('fails closed on an empty chain', async () => {
		await expect(verifyCompletionAuditChain([], CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed with a bound-exceeded error, not a generic integrity error, when the bound is exceeded', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(3));
		const oversized = new Array(5_001).fill(events[0]);
		await expect(verifyCompletionAuditChain(oversized, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactBoundExceededError
		);
	});

	it('fails closed on a sequence gap', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(3));
		events[1] = { ...events[1], sequence: 5 };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on a broken hash link', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(3));
		events[2] = { ...events[2], previousHash: 'wrong-hash' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when the root event has a previous hash', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(3));
		events[0] = { ...events[0], previousHash: 'unexpected' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when the chain does not end at envelope.completed', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, [
			...steps(2).slice(0, 1),
			{
				id: 'audit-event-2',
				eventType: 'recipient.signed',
				actorType: 'recipient',
				actorId: 'recipient-1',
				occurredAt: '2026-09-12T00:00:00.000Z',
				payload: { recipientId: 'recipient-1', fields: [] }
			}
		]);
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on an unknown event type', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, [
			...steps(2).slice(0, 1),
			{
				id: 'audit-event-2',
				eventType: 'envelope.mystery_event',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: {}
			}
		]);
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when a terminal recipient event does not end the chain with recipient actor type', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		// v2 hashes include actorType, so this both fails the actor-type check
		// and would fail hash recomputation. The verifier must still refuse.
		events[1] = { ...events[1], actorType: 'system' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on a draft revision event with an actor type outside user/agent/system', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, [
			{
				id: 'audit-event-1',
				eventType: 'draft.revision_created',
				actorType: 'recipient',
				actorId: 'recipient-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: { generation: 1 }
			},
			...steps(2).slice(1)
		]);
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on a non-canonical payload', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], payloadJson: '{"title":  "Step 1"}' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on malformed JSON in payload_json', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], payloadJson: '{not-json' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when a payload is altered without recomputing the hash', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], payloadJson: JSON.stringify({ title: 'Tampered' }) };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when the occurredAt used at write time is altered post hoc', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], occurredAt: '2026-09-11T00:00:00.001Z' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed on a non-canonical timestamp shape', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], occurredAt: '2026-09-11T00:00:00Z' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed with a bound-exceeded error when the aggregate payload byte budget is exceeded', async () => {
		const hugePayload = { blob: 'x'.repeat(5 * 1024 * 1024) };
		const events = await buildVerifiedAuditChain(CONTEXT, [
			{
				id: 'audit-event-1',
				eventType: 'envelope.created',
				actorType: 'user',
				actorId: 'user-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: hugePayload
			},
			...steps(2).slice(1)
		]);
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactBoundExceededError
		);
	});
});

describe('auditEventHashPreimage', () => {
	// These assert the exact raw JSON string, byte for byte, rather than
	// JSON.parse-ing it back into an object: a `toEqual` comparison on the
	// parsed object is blind to property order, but property order is part of
	// the hashed bytes (see the JSDoc on auditEventHashPreimage) and a writer
	// that emitted the same keys in a different order would produce a
	// different, unrecomputable hash. Parsing back and comparing objects would
	// not catch that regression, so it would be a self-referential test that
	// could pass even if the preimage no longer matched what the real writers
	// hash.
	it('hashes v2 events with hashVersion, actor type, and actor id in exact key order', async () => {
		const [event] = await buildVerifiedAuditChain(CONTEXT, [
			{
				id: 'audit-event-1',
				eventType: 'draft.revision_created',
				actorType: 'agent',
				actorId: 'agent-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: { generation: 1 }
			}
		]);
		const preimage = auditEventHashPreimage(event, { generation: 1 }, CONTEXT);
		expect(preimage).toBe(
			'{"hashVersion":2,"organizationId":"org-1","envelopeId":"envelope-1","sequence":1,' +
				'"eventType":"draft.revision_created","actorType":"agent","actorId":"agent-1",' +
				'"occurredAt":"2026-09-11T00:00:00.000Z","payload":{"generation":1},"previousHash":null}'
		);
	});

	it('preserves the legacy v1 draft revision shape when hashVersion is 1', async () => {
		const [event] = await buildVerifiedAuditChain(CONTEXT, [
			{
				id: 'audit-event-1',
				eventType: 'draft.revision_created',
				actorType: 'agent',
				actorId: 'agent-1',
				occurredAt: '2026-09-11T00:00:00.000Z',
				payload: { generation: 1 },
				hashVersion: 1
			}
		]);
		const preimage = auditEventHashPreimage(event, { generation: 1 }, CONTEXT);
		expect(preimage).toBe(
			'{"organizationId":"org-1","envelopeId":"envelope-1","sequence":1,' +
				'"eventType":"draft.revision_created","actorType":"agent","actorId":"agent-1",' +
				'"occurredAt":"2026-09-11T00:00:00.000Z","payload":{"generation":1},"previousHash":null}'
		);
	});

	it('preserves the legacy v1 generic shape without actor type when hashVersion is 1', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, [
			{ ...steps(2)[0], hashVersion: 1 },
			{ ...steps(2)[1], hashVersion: 1 }
		]);
		const event = events[0];
		const preimage = auditEventHashPreimage(event, { title: 'Step 1' }, CONTEXT);
		expect(preimage).toBe(
			'{"actorId":"user-1","envelopeId":"envelope-1","eventType":"envelope.created",' +
				'"occurredAt":"2026-09-12T00:00:00.000Z","organizationId":"org-1",' +
				'"payload":{"title":"Step 1"},"previousHash":null}'
		);
	});

	it('fails closed when a v2 actorType is tampered after hashing', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], actorType: 'agent' };
		await expect(verifyAuditEventRecord(events[0], CONTEXT)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('fails closed when a v2 actorId is tampered after hashing', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		events[0] = { ...events[0], actorId: 'tampered-actor' };
		await expect(verifyAuditEventRecord(events[0], CONTEXT)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});

	it('still verifies a legacy v1 chain whose actorType is not in the v1 preimage', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, [
			{ ...steps(2)[0], hashVersion: 1 },
			{ ...steps(2)[1], hashVersion: 1 }
		]);
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).resolves.toMatchObject({
			proof: { hashChainVerified: true, verifiedEventCount: 2 }
		});
		events[0] = { ...events[0], actorType: 'system' };
		await expect(verifyCompletionAuditChain(events, CONTEXT, 5_000)).rejects.toThrow(
			CompletionArtifactIntegrityError
		);
	});
});

describe('verifyAuditEventRecord', () => {
	it('returns the parsed payload for a valid event', async () => {
		const events = await buildVerifiedAuditChain(CONTEXT, steps(2));
		await expect(verifyAuditEventRecord(events[0], CONTEXT)).resolves.toEqual({ title: 'Step 1' });
	});
});
