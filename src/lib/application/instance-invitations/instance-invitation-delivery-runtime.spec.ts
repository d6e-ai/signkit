import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceInvitationDeliveryService } from './instance-invitation-delivery-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveInstanceInvitationDeliveryService } from './instance-invitation-delivery-runtime';

const TEST_ENCRYPTION_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

beforeEach((): void => {
	privateEnv.D6E_AUTH_BASE_URL = 'https://auth.example.com';
	privateEnv.D6E_AUTH_CLIENT_ID = 'd6e_client';
	privateEnv.D6E_AUTH_CLIENT_SECRET = 'd6es_secret';
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveInstanceInvitationDeliveryService', () => {
	it('needs the store, the delivery key, and the console registration on Workers, no mail provider', async () => {
		const service = await resolveInstanceInvitationDeliveryService({
			platform: workerPlatform({})
		});

		expect(service).toBeInstanceOf(InstanceInvitationDeliveryService);
	});

	it('fails closed without the delivery key or the database', async () => {
		await expect(
			resolveInstanceInvitationDeliveryService({
				platform: workerPlatform({ DELIVERY_ENCRYPTION_KEY: undefined })
			})
		).resolves.toBeNull();
		await expect(
			resolveInstanceInvitationDeliveryService({ platform: workerPlatform({ DB: undefined }) })
		).resolves.toBeNull();
	});

	it('is unavailable without the console registration, so no row spends an attempt', async () => {
		await expect(
			resolveInstanceInvitationDeliveryService({
				platform: workerPlatform({ SIGNKIT_CONSOLE_URL: undefined })
			})
		).resolves.toBeNull();
		await expect(
			resolveInstanceInvitationDeliveryService({
				platform: workerPlatform({ SIGNKIT_CONSOLE_URL: 'http://console.example.com/' })
			})
		).resolves.toBeNull();
		delete privateEnv.D6E_AUTH_CLIENT_SECRET;
		await expect(
			resolveInstanceInvitationDeliveryService({ platform: workerPlatform({}) })
		).resolves.toBeNull();
	});

	it('fails closed on Node without DATABASE_URL', async () => {
		privateEnv.DELIVERY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
		privateEnv.SIGNKIT_CONSOLE_URL = 'https://console.example.com/signkit/console';
		await expect(resolveInstanceInvitationDeliveryService({})).resolves.toBeNull();
	});
});

function workerPlatform(overrides: Record<string, unknown>): App.Platform {
	return {
		env: {
			DB: {} as D1Database,
			DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			SIGNKIT_CONSOLE_URL: 'https://console.example.com/signkit/console',
			...overrides
		}
	} as unknown as App.Platform;
}
