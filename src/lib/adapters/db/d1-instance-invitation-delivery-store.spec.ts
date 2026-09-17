import { describe, expect, it, vi } from 'vitest';
import {
	MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
	type ClaimInstanceInvitationDeliveriesCommand
} from '$lib/ports/instance-invitation-delivery-store';
import { D1InstanceInvitationDeliveryStore } from './d1-instance-invitation-delivery-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

function fakeD1() {
	const prepared: RecordedStatement[] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			}
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async () => [
		{ results: [], meta: { changes: 1 } },
		{ results: [], meta: { changes: 0 } },
		{ results: [], meta: { changes: 0 } }
	]);
	return { database: { prepare, batch } as unknown as D1Database, prepared };
}

const command: ClaimInstanceInvitationDeliveriesCommand = {
	claimToken: 'claim-token',
	claimedAt: '2026-09-17T12:00:00.000Z',
	staleBefore: '2026-09-17T11:55:00.000Z',
	limit: 25
};

describe('D1InstanceInvitationDeliveryStore', () => {
	it('terminally scrubs exhausted stale leases and never reclaims attempts past the cap', async () => {
		const { database, prepared } = fakeD1();
		const claimed = await new D1InstanceInvitationDeliveryStore(database).claimPending(command);
		expect(claimed).toEqual([]);
		expect(prepared).toHaveLength(3);
		expect(prepared[0].sql).toContain("THEN 'delivery_attempts_exhausted'");
		expect(prepared[0].sql).toContain('delivery.attempts >= ?');
		expect(prepared[0].sql).toContain('delivery.locked_at < ?');
		expect(prepared[0].bindings).toEqual([
			MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
			command.claimedAt,
			command.claimedAt,
			MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
			command.staleBefore
		]);
		expect(prepared[1].sql).toContain('delivery.attempts < ?');
		expect(prepared[1].bindings).toContain(MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS);
	});
});
