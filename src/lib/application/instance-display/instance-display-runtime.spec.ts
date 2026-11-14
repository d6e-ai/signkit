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

	it('keeps maintenance usable when the encryption key is malformed and does not log key material', async () => {
		const malformedKey: string = 'not-a-valid-delivery-key';
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		privateEnv.DELIVERY_ENCRYPTION_KEY = malformedKey;
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		try {
			const service = await resolveInstanceDisplayMaintenanceService({});
			expect(service).toBeInstanceOf(InstanceDisplayMaintenanceService);
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(malformedKey);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('wires D1 maintenance without SMTP when the previous key is malformed', async () => {
		const malformedPrevious: string = 'short';
		const errorSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		try {
			const platform = {
				env: {
					DB: {} as D1Database,
					DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
					DELIVERY_ENCRYPTION_KEY_PREVIOUS: malformedPrevious
				}
			} as App.Platform;
			expect(await resolveInstanceDisplayMaintenanceService({ platform })).toBeInstanceOf(
				InstanceDisplayMaintenanceService
			);
			expect(await resolveInstanceDisplayApplication({ platform })).toBeInstanceOf(
				InstanceDisplayApplication
			);
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(malformedPrevious);
			expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TEST_ENCRYPTION_KEY);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('fails closed on a Cloudflare platform without D1 instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveInstanceDisplayApplication({ platform })).resolves.toBeNull();
	});
});
