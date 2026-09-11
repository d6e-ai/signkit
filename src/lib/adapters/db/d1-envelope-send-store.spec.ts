import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishSentEnvelopeCommand } from '$lib/ports/envelope-send-store';
import { D1EnvelopeSendStore } from './d1-envelope-send-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}
function fakeD1(firstResults: readonly unknown[], allResults: readonly unknown[] = []) {
	const first: unknown[] = [...firstResults];
	const all: unknown[] = [...allResults];
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			first: async (): Promise<unknown | null> => first.shift() ?? null,
			all: async (): Promise<{ results: unknown[] }> => ({
				results: (all.shift() as unknown[] | undefined) ?? []
			})
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async (statements: D1PreparedStatement[]): Promise<unknown[]> => {
		batches.push(
			statements.map((statement) => prepared.find((item) => item.statement === statement)!)
		);
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
}

const sealedDigest: string = createHash('sha256').update('sealed').digest('hex');

const command: PublishSentEnvelopeCommand = {
	organizationId: 'org-1',
	envelopeId: 'env-1',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'send-1',
	requestFingerprint: '',
	expectedGeneration: 2,
	expectedReadyAuditEventId: 'ready-audit',
	commitSha: 'commit-2',
	initialRoutingOrder: 1,
	deliveries: [
		{
			id: 'delivery-1',
			recipientId: 'recipient-1',
			capabilityHash: 'cap-hash',
			capabilityExpiresAt: '2026-09-25T00:02:00.000Z',
			sealedCapability: 'sealed',
			sealingKeyId: 'key-1',
			sealedCapabilitySha256: sealedDigest,
			status: 'pending',
			availableAt: '2026-09-11T00:02:00.000Z'
		}
	],
	deliveryManifestJson: '',
	deliveryManifestHash: '',
	initialCapabilityExpiresAt: '2026-09-25T00:02:00.000Z',
	updatedAt: '2026-09-11T00:02:00.000Z',
	expectedAuditSequence: 2,
	previousAuditHash: 'hash-2',
	auditEventId: 'sent-audit',
	auditEventHash: 'hash-3',
	auditPayloadJson: ''
};
command.deliveryManifestJson = JSON.stringify([
	{
		id: 'delivery-1',
		recipientId: 'recipient-1',
		capabilityHash: 'cap-hash',
		capabilityExpiresAt: '2026-09-25T00:02:00.000Z',
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: sealedDigest,
		initialStatus: 'pending',
		initialAvailableAt: '2026-09-11T00:02:00.000Z'
	}
]);
command.deliveryManifestHash = createHash('sha256')
	.update(command.deliveryManifestJson)
	.digest('hex');
command.requestFingerprint = createHash('sha256')
	.update(JSON.stringify({ expectedGeneration: 2, expectedReadyAuditEventId: 'ready-audit' }))
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	commitSha: 'commit-2',
	generation: 2,
	readyAuditEventId: 'ready-audit',
	initialRoutingOrder: 1,
	queuedDeliveryCount: 1,
	reservedCapabilityCount: 1,
	deliveryManifestHash: command.deliveryManifestHash,
	initialCapabilityExpiresAt: '2026-09-25T00:02:00.000Z'
});

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		organization_id: 'org-1',
		envelope_id: 'env-1',
		actor_type: 'user',
		actor_id: 'user-1',
		request_hash: command.requestFingerprint,
		expected_generation: 2,
		ready_audit_event_id: 'ready-audit',
		commit_sha: 'commit-2',
		initial_routing_order: 1,
		delivery_count: 1,
		queued_delivery_count: 1,
		delivery_manifest_hash: command.deliveryManifestHash,
		delivery_manifest_json: command.deliveryManifestJson,
		initial_capability_expires_at: command.initialCapabilityExpiresAt,
		updated_at: command.updatedAt,
		audit_event_id: 'sent-audit',
		audit_sequence: 3,
		previous_audit_hash: 'hash-2',
		audit_event_hash: 'hash-3',
		audit_payload_json: command.auditPayloadJson,
		evidence_event_id: 'sent-audit',
		evidence_organization_id: 'org-1',
		evidence_envelope_id: 'env-1',
		evidence_sequence: 3,
		evidence_event_type: 'envelope.sent',
		evidence_actor_type: 'user',
		evidence_actor_id: 'user-1',
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: 'hash-2',
		evidence_event_hash: 'hash-3',
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

describe('D1EnvelopeSendStore', () => {
	it('publishes command, capability, outbox, then final guard in one ordered batch', async () => {
		const fake = fakeD1([null]);
		await expect(
			new D1EnvelopeSendStore(fake.database).publishSend(command)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO envelope_send_command'),
			expect.stringContaining('UPDATE recipient'),
			expect.stringContaining('INSERT INTO delivery_outbox'),
			expect.stringContaining('INSERT INTO envelope_send_publish')
		]);
		expect(fake.batches[0][2].bindings).toContain('sealed');
	});
	it('replays only audit-linked evidence with the same request', async () => {
		const evidence = [
			{
				id: 'delivery-1',
				recipient_id: 'recipient-1',
				status: 'pending',
				capability_hash: 'cap-hash',
				reserved_capability_expires_at: '2026-09-25T00:02:00.000Z',
				sealed_capability: 'sealed',
				sealing_key_id: 'key-1',
				sealed_capability_sha256: sealedDigest,
				recipient_capability_hash: 'cap-hash'
			}
		];
		await expect(
			new D1EnvelopeSendStore(fakeD1([storedRow()], [evidence]).database).prepareSend(
				command,
				2,
				'ready-audit'
			)
		).resolves.toMatchObject({
			outcome: 'replayed',
			result: { status: 'sent', queuedDeliveryCount: 1 }
		});
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow({ evidence_event_type: 'wrong' })], [evidence]).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow()], [[{ ...evidence[0], sealed_capability: null }]]).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
	});
});
