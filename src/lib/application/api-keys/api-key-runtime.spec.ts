import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyApplication, type ApiKeyApplicationPort } from './api-key-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveApiKeyApplication } from './api-key-runtime';

const TEST_DATABASE_URL: string = 'postgres://signkit:secret@localhost:5432/signkit';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveApiKeyApplication', () => {
	it('returns null when no durable store is configured', async () => {
		await expect(resolveApiKeyApplication({})).resolves.toBeNull();
	});

	it('uses the D1 binding when the Cloudflare platform provides one', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;
		const application: ApiKeyApplicationPort | null = await resolveApiKeyApplication({
			platform
		});
		expect(application).toBeInstanceOf(ApiKeyApplication);
	});

	it('fails closed on a Cloudflare platform without a D1 binding instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveApiKeyApplication({ platform })).resolves.toBeNull();
	});

	it('constructs the PostgreSQL application from DATABASE_URL on Node runtimes', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const application: ApiKeyApplicationPort | null = await resolveApiKeyApplication({});
		expect(application).toBeInstanceOf(ApiKeyApplication);
	});

	it('treats a blank DATABASE_URL as unconfigured', async () => {
		privateEnv.DATABASE_URL = '   ';
		await expect(resolveApiKeyApplication({})).resolves.toBeNull();
	});
});
