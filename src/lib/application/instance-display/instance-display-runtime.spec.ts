import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceDisplayApplication } from './instance-display-service';
import { InstanceDisplayMaintenanceService } from './instance-display-maintenance-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));
vi.mock('$lib/application/runtime/postgres-sql-runtime', () => ({
	resolvePostgresSql: vi.fn(() => ({}))
}));

import {
	resolveInstanceDisplayApplication,
	resolveInstanceDisplayMaintenanceService
} from './instance-display-runtime';

const TEST_DATABASE_URL: string = 'postgres://signkit:secret@localhost:5432/signkit';
const TEST_ENCRYPTION_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('instance display runtime', () => {
	it('returns null when no durable store is configured', async () => {
		await expect(resolveInstanceDisplayApplication({})).resolves.toBeNull();
		await expect(resolveInstanceDisplayMaintenanceService({})).resolves.toBeNull();
	});

	it('wires the D1 store for both list enrichment and maintenance without mail config', async () => {
		const platform = {
			env: { DB: {} as D1Database, DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY }
		} as App.Platform;
		expect(await resolveInstanceDisplayApplication({ platform })).toBeInstanceOf(
			InstanceDisplayApplication
		);
		expect(await resolveInstanceDisplayMaintenanceService({ platform })).toBeInstanceOf(
			InstanceDisplayMaintenanceService
		);
	});

	it('wires PostgreSQL maintenance without an encryption key so cleanup can still run', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const service = await resolveInstanceDisplayMaintenanceService({});
		expect(service).toBeInstanceOf(InstanceDisplayMaintenanceService);
	});

	it('fails closed on a Cloudflare platform without D1 instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveInstanceDisplayApplication({ platform })).resolves.toBeNull();
	});
});
