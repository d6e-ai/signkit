import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitationDeliveryService } from './delivery-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveInvitationDeliveryService } from './delivery-runtime';

const TEST_ENCRYPTION_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TEST_PUBLIC_ORIGIN = 'https://sign.example.com';
const TEST_FROM_EMAIL = 'sign@sign.example.com';
const TEST_FROM_NAME = 'SignKit';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveInvitationDeliveryService', () => {
	it('returns null when no delivery configuration exists', async () => {
		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Workers when the mail provider is unset', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				EMAIL: {} as SendEmail,
				...deliveryEnv()
			}
		} as unknown as App.Platform;

		await expect(resolveInvitationDeliveryService({ platform })).resolves.toBeNull();
	});

	it('fails closed on Workers when the mail provider is smtp instead of cloudflare', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				EMAIL: {} as SendEmail,
				SIGNKIT_MAIL_PROVIDER: 'smtp',
				...deliveryEnv()
			}
		} as unknown as App.Platform;

		await expect(resolveInvitationDeliveryService({ platform })).resolves.toBeNull();
	});

	it('fails closed on Workers when the EMAIL binding is missing even though cloudflare is selected', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				...deliveryEnv()
			}
		} as unknown as App.Platform;

		await expect(resolveInvitationDeliveryService({ platform })).resolves.toBeNull();
	});

	it('uses the native EMAIL binding when cloudflare is selected on Workers', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				EMAIL: {} as SendEmail,
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				...deliveryEnv()
			}
		} as unknown as App.Platform;

		const service = await resolveInvitationDeliveryService({ platform });
		expect(service).toBeInstanceOf(InvitationDeliveryService);
	});

	it('fails closed on Node when the mail provider is unset', async () => {
		setCompleteNodeConfiguration();

		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Node when the mail provider is invalid', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'sendgrid';

		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Node when cloudflare is selected but credentials are missing', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'cloudflare';

		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('constructs a Cloudflare REST delivery service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'cloudflare';
		privateEnv.CLOUDFLARE_EMAIL_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		privateEnv.CLOUDFLARE_EMAIL_API_TOKEN = 'cloudflare-api-token';

		const service = await resolveInvitationDeliveryService({});
		expect(service).toBeInstanceOf(InvitationDeliveryService);
	});

	it('fails closed on Node when smtp is selected but the configuration is incomplete', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'smtp';
		privateEnv.SIGNKIT_SMTP_HOST = 'smtp.example.com';

		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Node when smtp username is set without a password', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'smtp';
		privateEnv.SIGNKIT_SMTP_HOST = 'smtp.example.com';
		privateEnv.SIGNKIT_SMTP_PORT = '587';
		privateEnv.SIGNKIT_SMTP_USERNAME = 'relay-user';

		await expect(resolveInvitationDeliveryService({})).resolves.toBeNull();
	});

	it('constructs an SMTP delivery service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'smtp';
		privateEnv.SIGNKIT_SMTP_HOST = 'smtp.example.com';
		privateEnv.SIGNKIT_SMTP_PORT = '587';
		privateEnv.SIGNKIT_SMTP_SECURE = 'false';
		privateEnv.SIGNKIT_SMTP_USERNAME = 'relay-user';
		privateEnv.SIGNKIT_SMTP_PASSWORD = 'relay-pass';

		const service = await resolveInvitationDeliveryService({});
		expect(service).toBeInstanceOf(InvitationDeliveryService);
	});
});

function deliveryEnv(): Record<string, string> {
	return {
		DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
		SIGNKIT_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
		SIGNKIT_EMAIL_FROM: TEST_FROM_EMAIL,
		SIGNKIT_EMAIL_FROM_NAME: TEST_FROM_NAME
	};
}

function setCompleteNodeConfiguration(): void {
	privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
	Object.assign(privateEnv, deliveryEnv());
}
