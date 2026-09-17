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
	it('fails closed on Workers when the provider is unset', async () => {
		await expect(
			resolveInstanceInvitationDeliveryService({ platform: workerPlatform({}) })
		).resolves.toBeNull();
	});

	it('uses SMTP on Workers without an EMAIL binding', async () => {
		const service = await resolveInstanceInvitationDeliveryService({
			platform: workerPlatform({
				SIGNKIT_MAIL_PROVIDER: 'smtp',
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'false'
			})
		});

		expect(service).toBeInstanceOf(InstanceInvitationDeliveryService);
	});

	it('fails closed on Workers when SMTP uses prohibited port 25', async () => {
		await expect(
			resolveInstanceInvitationDeliveryService({
				platform: workerPlatform({
					SIGNKIT_MAIL_PROVIDER: 'smtp',
					SIGNKIT_SMTP_HOST: 'smtp.example.com',
					SIGNKIT_SMTP_PORT: '25',
					SIGNKIT_SMTP_SECURE: 'false'
				})
			})
		).resolves.toBeNull();
	});

	it('uses the native EMAIL binding when Cloudflare Email is selected', async () => {
		const service = await resolveInstanceInvitationDeliveryService({
			platform: workerPlatform({
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				EMAIL: {} as SendEmail
			})
		});

		expect(service).toBeInstanceOf(InstanceInvitationDeliveryService);
	});
});

function workerPlatform(overrides: Record<string, unknown>): App.Platform {
	return {
		env: {
			DB: {} as D1Database,
			DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			SIGNKIT_PUBLIC_ORIGIN: 'https://sign.example.com',
			SIGNKIT_EMAIL_FROM: 'sign@sign.example.com',
			SIGNKIT_EMAIL_FROM_NAME: 'SignKit',
			...overrides
		}
	} as unknown as App.Platform;
}
