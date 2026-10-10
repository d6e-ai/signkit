import { describe, expect, it, vi } from 'vitest';
import { MaintenanceBacklogCorruptionError } from './maintenance-backlog';
import { D1MaintenanceBacklog } from './maintenance-backlog-d1';

describe('D1MaintenanceBacklog', () => {
	it('maps every queue row to bounded counts and both ages, never raw identifiers', async () => {
		const now: Date = new Date('2026-01-01T00:10:00Z');
		let bound: readonly unknown[] = [];
		const prepare = vi.fn(
			(): D1PreparedStatement =>
				({
					bind: (...args: unknown[]): D1PreparedStatement => {
						bound = args;
						return {
							all: async (): Promise<object> => ({
								success: true,
								results: [
									{
										queue: 'delivery',
										pending_count: 2,
										oldest_pending_created_at: '2025-12-31T23:00:00Z',
										oldest_overdue_available_at: '2026-01-01T00:00:00Z',
										permanently_failed_count: 1
									},
									{
										queue: 'webhook_delivery',
										pending_count: 0,
										oldest_pending_created_at: null,
										oldest_overdue_available_at: null,
										permanently_failed_count: 0
									}
								]
							})
						} as unknown as D1PreparedStatement;
					}
				}) as unknown as D1PreparedStatement
		);
		const database: D1Database = { prepare } as unknown as D1Database;

		const snapshot = await new D1MaintenanceBacklog(database).snapshot(now);

		expect(snapshot).toEqual([
			{
				queue: 'delivery',
				pendingCount: 2,
				oldestPendingAgeSeconds: 4200,
				oldestOverdueAgeSeconds: 600,
				permanentlyFailedCount: 1
			},
			{
				queue: 'webhook_delivery',
				pendingCount: 0,
				oldestPendingAgeSeconds: null,
				oldestOverdueAgeSeconds: null,
				permanentlyFailedCount: 0
			}
		]);
		expect(bound).toEqual(new Array(7).fill(now.toISOString()));
	});

	it('throws rather than reporting a corrupted non-null timestamp as a healthy null age', async () => {
		const prepare = vi.fn(
			(): D1PreparedStatement =>
				({
					bind: (): D1PreparedStatement =>
						({
							all: async (): Promise<object> => ({
								success: true,
								results: [
									{
										queue: 'pdf_seal',
										pending_count: 1,
										oldest_pending_created_at: 'not-a-timestamp',
										oldest_overdue_available_at: null,
										permanently_failed_count: 0
									}
								]
							})
						}) as unknown as D1PreparedStatement
				}) as unknown as D1PreparedStatement
		);
		const database: D1Database = { prepare } as unknown as D1Database;

		await expect(new D1MaintenanceBacklog(database).snapshot(new Date())).rejects.toBeInstanceOf(
			MaintenanceBacklogCorruptionError
		);
	});

	it('queries every durable queue table read-only, with no row-level identifiers selected', async () => {
		let sql: string = '';
		const prepare = vi.fn((statementSql: string): D1PreparedStatement => {
			sql = statementSql;
			return {
				bind: (): D1PreparedStatement =>
					({
						all: async (): Promise<object> => ({ success: true, results: [] })
					}) as unknown as D1PreparedStatement
			} as unknown as D1PreparedStatement;
		});
		const database: D1Database = { prepare } as unknown as D1Database;

		await new D1MaintenanceBacklog(database).snapshot(new Date());

		for (const table of [
			'delivery_outbox',
			'instance_invitation_delivery_outbox',
			'completion_delivery_outbox',
			'completion_artifact_job',
			'docx_conversion_job',
			'pdf_seal_job',
			'webhook_outbox'
		]) {
			expect(sql).toContain(table);
		}
		expect(sql.toUpperCase()).not.toContain('DELETE');
		expect(sql.toUpperCase()).not.toContain('UPDATE');
		expect(sql.toUpperCase()).not.toContain('INSERT');
		for (const projection of sql.matchAll(/SELECT([\s\S]*?)FROM/g)) {
			expect(projection[1]).not.toMatch(/\bid\b|envelope_id|recipient_id|last_error|payload/);
		}
		expect(sql).toContain('event.id = webhook_outbox.audit_event_id');
	});
});
