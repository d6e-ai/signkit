import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkloadKeyApplication, type WorkloadKeyApplicationPort } from './workload-key-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveWorkloadKeyApplication } from './workload-key-runtime';

const TEST_DATABASE_URL: string = 'postgres://signkit:secret@localhost:5432/signkit';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveWorkloadKeyApplication', () => {
	it('returns null when no durable store is configured', async () => {
		await expect(resolveWorkloadKeyApplication({})).resolves.toBeNull();
	});

	it('uses the D1 binding when the Cloudflare platform provides one', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;
		const application: WorkloadKeyApplicationPort | null = await resolveWorkloadKeyApplication({
			platform
		});
		expect(application).toBeInstanceOf(WorkloadKeyApplication);
	});

	it('fails closed on a Cloudflare platform without a D1 binding instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveWorkloadKeyApplication({ platform })).resolves.toBeNull();
	});

	it('constructs the PostgreSQL application from DATABASE_URL on Node runtimes', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const application: WorkloadKeyApplicationPort | null = await resolveWorkloadKeyApplication({});
		expect(application).toBeInstanceOf(WorkloadKeyApplication);
	});

	it('treats a blank DATABASE_URL as unconfigured', async () => {
		privateEnv.DATABASE_URL = '   ';
		await expect(resolveWorkloadKeyApplication({})).resolves.toBeNull();
	});
});
