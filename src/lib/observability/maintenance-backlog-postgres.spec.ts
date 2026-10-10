import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { MaintenanceBacklogCorruptionError } from './maintenance-backlog';
import { PostgresMaintenanceBacklog } from './maintenance-backlog-postgres';

function fakeSql(rows: readonly object[]): {
	sql: ReturnType<typeof postgres>;
	query: () => string;
	params: () => readonly unknown[];
} {
	let query: string = '';
	let params: readonly unknown[] = [];
	const unsafe = vi.fn(
		async (text: string, values?: readonly unknown[]): Promise<readonly object[]> => {
			query = text;
			params = values ?? [];
			return rows;
		}
	);
	return {
		sql: { unsafe } as unknown as ReturnType<typeof postgres>,
		query: () => query,
		params: () => params
	};
}

describe('PostgresMaintenanceBacklog', () => {
	it('maps every queue row to bounded counts and both ages', async () => {
		const now: Date = new Date('2026-01-01T00:10:00Z');
		const fake = fakeSql([
			{
				queue: 'pdf_seal',
				pending_count: 3,
				oldest_pending_created_at: new Date('2025-12-31T23:00:00Z'),
				oldest_overdue_available_at: new Date('2026-01-01T00:05:00Z'),
				permanently_failed_count: 2
			}
		]);

		const snapshot = await new PostgresMaintenanceBacklog(fake.sql).snapshot(now);

		expect(snapshot).toEqual([
			{
				queue: 'pdf_seal',
				pendingCount: 3,
				oldestPendingAgeSeconds: 4200,
				oldestOverdueAgeSeconds: 300,
				permanentlyFailedCount: 2
			}
		]);
		expect(fake.params()).toEqual([now.toISOString()]);
	});

	it('throws rather than reporting a corrupted non-null timestamp as a healthy null age', async () => {
		const fake = fakeSql([
			{
				queue: 'webhook_delivery',
				pending_count: 1,
				oldest_pending_created_at: 'not-a-timestamp',
				oldest_overdue_available_at: null,
				permanently_failed_count: 0
			}
		]);

		await expect(
			new PostgresMaintenanceBacklog(fake.sql).snapshot(new Date())
		).rejects.toBeInstanceOf(MaintenanceBacklogCorruptionError);
	});

	it('queries every durable queue table read-only, with no row-level identifiers selected', async () => {
		const fake = fakeSql([]);

		await new PostgresMaintenanceBacklog(fake.sql).snapshot(new Date());

		for (const table of [
			'delivery_outbox',
			'instance_invitation_delivery_outbox',
			'completion_delivery_outbox',
			'completion_artifact_job',
			'docx_conversion_job',
			'pdf_seal_job',
			'webhook_outbox'
		]) {
			expect(fake.query()).toContain(table);
		}
		expect(fake.query().toUpperCase()).not.toContain('DELETE');
		expect(fake.query().toUpperCase()).not.toContain('UPDATE');
		expect(fake.query().toUpperCase()).not.toContain('INSERT');
		for (const projection of fake.query().matchAll(/SELECT([\s\S]*?)FROM/g)) {
			expect(projection[1]).not.toMatch(/\bid\b|envelope_id|recipient_id|last_error|payload/);
		}
		expect(fake.query()).toContain('event.id = webhook_outbox.audit_event_id');
	});
});
