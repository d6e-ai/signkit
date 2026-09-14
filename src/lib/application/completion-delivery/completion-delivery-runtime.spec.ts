import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionDeliveryService } from './completion-delivery-service';
import { PublicCompletionArtifactService } from './public-completion-artifact';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	resolveCompletionDeliveryService,
	resolvePublicCompletionArtifactService
} from './completion-delivery-runtime';

const TEST_ENCRYPTION_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TEST_PUBLIC_ORIGIN = 'https://sign.example.com';
const TEST_FROM_EMAIL = 'sign@sign.example.com';
const TEST_FROM_NAME = 'SignKit';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolvePublicCompletionArtifactService', () => {
	it('returns null when no durable Node configuration exists', async () => {
		await expect(resolvePublicCompletionArtifactService({})).resolves.toBeNull();
	});

	it('fails closed on an incomplete Cloudflare binding set without falling through to S3', async () => {
		setCompleteNodeConfiguration();
		const platform = { env: { DB: {} as D1Database } } as App.Platform;

		await expect(resolvePublicCompletionArtifactService({ platform })).resolves.toBeNull();
	});

	it('uses native D1 and R2 bindings when both are present', async () => {
		const platform = {
			env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
		} as App.Platform;

		const service = await resolvePublicCompletionArtifactService({ platform });
		expect(service).toBeInstanceOf(PublicCompletionArtifactService);
	});

	it('constructs a PostgreSQL and S3 public artifact service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();

		const service = await resolvePublicCompletionArtifactService({});
		expect(service).toBeInstanceOf(PublicCompletionArtifactService);
	});
});

describe('resolveCompletionDeliveryService', () => {
	it('returns null when no delivery configuration exists', async () => {
		await expect(resolveCompletionDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on an incomplete Cloudflare binding set without falling through to Node REST', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		const platform = {
			env: {
				DB: {} as D1Database,
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				SIGNKIT_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
				SIGNKIT_EMAIL_FROM: TEST_FROM_EMAIL,
				SIGNKIT_EMAIL_FROM_NAME: TEST_FROM_NAME
			}
		} as unknown as App.Platform;

		await expect(resolveCompletionDeliveryService({ platform })).resolves.toBeNull();
	});

	it('fails closed on Workers when SIGNKIT_MAIL_PROVIDER is smtp instead of cloudflare', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				EMAIL: {} as SendEmail,
				SIGNKIT_MAIL_PROVIDER: 'smtp',
				DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				SIGNKIT_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
				SIGNKIT_EMAIL_FROM: TEST_FROM_EMAIL,
				SIGNKIT_EMAIL_FROM_NAME: TEST_FROM_NAME
			}
		} as unknown as App.Platform;

		await expect(resolveCompletionDeliveryService({ platform })).resolves.toBeNull();
	});

	it('uses native D1, EMAIL, and sealer when complete Cloudflare environment is present', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				EMAIL: {} as SendEmail,
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				SIGNKIT_PUBLIC_ORIGIN: TEST_PUBLIC_ORIGIN,
				SIGNKIT_EMAIL_FROM: TEST_FROM_EMAIL,
				SIGNKIT_EMAIL_FROM_NAME: TEST_FROM_NAME
			}
		} as unknown as App.Platform;

		const service = await resolveCompletionDeliveryService({ platform });
		expect(service).toBeInstanceOf(CompletionDeliveryService);
	});

	it('fails closed on Node when the mail provider is unset', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();

		await expect(resolveCompletionDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Node when the mail provider is invalid', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'sendgrid';

		await expect(resolveCompletionDeliveryService({})).resolves.toBeNull();
	});

	it('fails closed on Node when Cloudflare REST credentials are missing', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'cloudflare';

		await expect(resolveCompletionDeliveryService({})).resolves.toBeNull();
	});

	it('constructs a PostgreSQL and Cloudflare REST delivery service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'cloudflare';
		privateEnv.CLOUDFLARE_EMAIL_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
		privateEnv.CLOUDFLARE_EMAIL_API_TOKEN = 'cloudflare-api-token';

		const service = await resolveCompletionDeliveryService({});
		expect(service).toBeInstanceOf(CompletionDeliveryService);
	});

	it('fails closed on Node when the mail provider is smtp but the SMTP configuration is incomplete', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'smtp';
		privateEnv.SIGNKIT_SMTP_HOST = 'smtp.example.com';

		await expect(resolveCompletionDeliveryService({})).resolves.toBeNull();
	});

	it('constructs a PostgreSQL and SMTP delivery service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();
		setCompleteDeliveryConfiguration();
		privateEnv.SIGNKIT_MAIL_PROVIDER = 'smtp';
		privateEnv.SIGNKIT_SMTP_HOST = 'smtp.example.com';
		privateEnv.SIGNKIT_SMTP_PORT = '587';
		privateEnv.SIGNKIT_SMTP_SECURE = 'false';

		const service = await resolveCompletionDeliveryService({});
		expect(service).toBeInstanceOf(CompletionDeliveryService);
	});
});

function setCompleteNodeConfiguration(): void {
	privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
	privateEnv.S3_ENDPOINT = 'http://127.0.0.1:9000';
	privateEnv.S3_REGION = 'us-east-1';
	privateEnv.S3_BUCKET = 'signkit';
	privateEnv.S3_ACCESS_KEY_ID = 'test-access-key';
	privateEnv.S3_SECRET_ACCESS_KEY = 'test-secret-key';
	privateEnv.S3_FORCE_PATH_STYLE = 'true';
}

function setCompleteDeliveryConfiguration(): void {
	privateEnv.DELIVERY_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	privateEnv.SIGNKIT_PUBLIC_ORIGIN = TEST_PUBLIC_ORIGIN;
	privateEnv.SIGNKIT_EMAIL_FROM = TEST_FROM_EMAIL;
	privateEnv.SIGNKIT_EMAIL_FROM_NAME = TEST_FROM_NAME;
}
