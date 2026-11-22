import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceInvitationDeliveryService } from './instance-invitation-delivery-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveInstanceInvitationDeliveryService } from './instance-invitation-delivery-runtime';

const TEST_ENCRYPTION_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveInstanceInvitationDeliveryService', () => {
	it('needs only the durable store and the delivery key on Workers, no mail provider', async () => {
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

	it('fails closed on Node without DATABASE_URL', async () => {
		privateEnv.DELIVERY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
		await expect(resolveInstanceInvitationDeliveryService({})).resolves.toBeNull();
	});
});

function workerPlatform(overrides: Record<string, unknown>): App.Platform {
	return {
		env: {
			DB: {} as D1Database,
			DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			...overrides
		}
	} as unknown as App.Platform;
}
