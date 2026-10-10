import { describe, expect, it } from 'vitest';
import {
	MaintenanceBacklogCorruptionError,
	maintenanceBacklogAgeSeconds
} from './maintenance-backlog';

describe('maintenanceBacklogAgeSeconds', () => {
	it('returns null when there is no oldest row', () => {
		expect(
			maintenanceBacklogAgeSeconds(new Date('2026-01-01T00:00:00Z'), 'delivery', 'created_at', null)
		).toBeNull();
	});

	it('computes the age in whole seconds for a string timestamp', () => {
		const now: Date = new Date('2026-01-01T00:05:00Z');
		expect(
			maintenanceBacklogAgeSeconds(now, 'delivery', 'created_at', '2026-01-01T00:00:00Z')
		).toBe(300);
	});

	it('computes the age in whole seconds for a Date timestamp', () => {
		const now: Date = new Date('2026-01-01T00:05:00Z');
		expect(
			maintenanceBacklogAgeSeconds(now, 'delivery', 'created_at', new Date('2026-01-01T00:04:30Z'))
		).toBe(30);
	});

	it('never returns a negative age', () => {
		const now: Date = new Date('2026-01-01T00:00:00Z');
		expect(
			maintenanceBacklogAgeSeconds(now, 'delivery', 'created_at', '2026-01-01T00:05:00Z')
		).toBe(0);
	});

	it('throws rather than silently reporting a corrupted non-null timestamp as healthy', () => {
		const now: Date = new Date('2026-01-01T00:00:00Z');
		expect(() =>
			maintenanceBacklogAgeSeconds(now, 'pdf_seal', 'created_at', 'not-a-timestamp')
		).toThrow(MaintenanceBacklogCorruptionError);
	});
});
