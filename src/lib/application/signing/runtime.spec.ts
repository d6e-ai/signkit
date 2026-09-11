import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipientAccessService } from './recipient-access';
import { RecipientViewedApplication } from './recipient-viewed';
import { RecipientWorkspaceService } from './recipient-workspace';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	resolveRecipientAccessApplication,
	resolveRecipientViewedApplication,
	resolveRecipientWorkspaceApplication
} from './runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveRecipientWorkspaceApplication', () => {
	it('fails closed on a Cloudflare request missing either D1 or R2', async () => {
		setCompleteNodeConfiguration();
		await expect(
			resolveRecipientWorkspaceApplication({
				platform: { env: { DB: {} as D1Database } } as App.Platform
			})
		).resolves.toBeNull();
		await expect(
			resolveRecipientWorkspaceApplication({
				platform: { env: { OBJECTS: {} as R2Bucket } } as App.Platform
			})
		).resolves.toBeNull();
	});

	it('uses request-scoped D1 and R2 together', async () => {
		await expect(
			resolveRecipientWorkspaceApplication({
				platform: {
					env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
				} as App.Platform
			})
		).resolves.toBeInstanceOf(RecipientWorkspaceService);
	});

	it('returns null when Node has no PostgreSQL or S3 configuration', async () => {
		await expect(resolveRecipientWorkspaceApplication({})).resolves.toBeNull();
	});

	it('rejects partial Node storage configuration without exposing its values', async () => {
		privateEnv.DATABASE_URL = 'postgres://sensitive-user:sensitive-password@db/signkit';
		privateEnv.S3_ENDPOINT = 'https://objects.example.com';
		await expect(resolveRecipientWorkspaceApplication({})).rejects.toThrow(
			'S3_REGION is required for S3 draft persistence'
		);
	});

	it('constructs the PostgreSQL and S3 workspace runtime from complete configuration', async () => {
		setCompleteNodeConfiguration();
		await expect(resolveRecipientWorkspaceApplication({})).resolves.toBeInstanceOf(
			RecipientWorkspaceService
		);
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

describe('resolveRecipientAccessApplication', () => {
	it('fails closed on a Cloudflare request without D1 instead of falling back to PostgreSQL', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		const platform = { env: {} } as App.Platform;
		await expect(resolveRecipientAccessApplication({ platform })).resolves.toBeNull();
	});

	it('uses the request-scoped D1 binding when present', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;
		const application = await resolveRecipientAccessApplication({
			platform
		});
		expect(application).toBeInstanceOf(RecipientAccessService);
	});

	it('returns null when a Node deployment has no PostgreSQL configuration', async () => {
		await expect(resolveRecipientAccessApplication({})).resolves.toBeNull();
	});
});

describe('resolveRecipientViewedApplication', () => {
	it('fails closed on a Cloudflare request without D1 instead of falling back to PostgreSQL', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		await expect(
			resolveRecipientViewedApplication({ platform: { env: {} } as App.Platform })
		).resolves.toBeNull();
	});

	it('uses one request-scoped D1 binding for access and atomic publication', async () => {
		await expect(
			resolveRecipientViewedApplication({
				platform: { env: { DB: {} as D1Database } } as App.Platform
			})
		).resolves.toBeInstanceOf(RecipientViewedApplication);
	});

	it('returns null without Node PostgreSQL configuration', async () => {
		await expect(resolveRecipientViewedApplication({})).resolves.toBeNull();
	});

	it('constructs the PostgreSQL application from complete Node configuration', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		await expect(resolveRecipientViewedApplication({})).resolves.toBeInstanceOf(
			RecipientViewedApplication
		);
	});
});
