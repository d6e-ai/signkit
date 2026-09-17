import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
	MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS,
	type ClaimInstanceInvitationDeliveriesCommand
} from '$lib/ports/instance-invitation-delivery-store';
import { PostgresInstanceInvitationDeliveryStore } from './postgres-instance-invitation-delivery-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];

	client(): ReturnType<typeof postgres> {
		const tag = (async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			this.queries.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			return [];
		}) as ReturnType<typeof postgres>;
		Object.assign(tag, {
			begin: async <T>(callback: (transaction: ReturnType<typeof postgres>) => Promise<T>) =>
				callback(tag)
		});
		return tag;
	}
}

const command: ClaimInstanceInvitationDeliveriesCommand = {
	claimToken: 'claim-token',
	claimedAt: '2026-09-17T12:00:00.000Z',
	staleBefore: '2026-09-17T11:55:00.000Z',
	limit: 25
};

describe('PostgresInstanceInvitationDeliveryStore', () => {
	it('terminally scrubs exhausted stale leases and never reclaims attempts past the cap', async () => {
		const scripted = new ScriptedPostgres();
		const claimed = await new PostgresInstanceInvitationDeliveryStore(
			scripted.client()
		).claimPending(command);
		expect(claimed).toEqual([]);
		expect(scripted.queries).toHaveLength(2);
		expect(scripted.queries[0].text).toContain("THEN 'delivery_attempts_exhausted'");
		expect(scripted.queries[0].text).toContain('delivery.attempts >= ?');
		expect(scripted.queries[0].text).toContain('delivery.locked_at < ?::timestamptz');
		expect(scripted.queries[0].values).toContain(MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS);
		expect(scripted.queries[0].values).toContain(command.staleBefore);
		expect(scripted.queries[1].text).toContain('delivery.attempts < ?');
		expect(scripted.queries[1].values).toContain(MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS);
	});
});
