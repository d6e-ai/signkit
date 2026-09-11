import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftPersistenceService } from './draft-persistence';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveDraftPersistenceService } from './runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveDraftPersistenceService', () => {
	it('returns null when no durable Node configuration exists', async () => {
		await expect(resolveDraftPersistenceService({})).resolves.toBeNull();
	});

	it('fails closed on an incomplete Cloudflare binding set without using S3', async () => {
		setCompleteNodeConfiguration();
		const platform = {
			env: { DB: {} as D1Database }
		} as App.Platform;

		await expect(resolveDraftPersistenceService({ platform })).resolves.toBeNull();
	});

	it('uses native D1 and R2 bindings when both are present', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				OBJECTS: {} as R2Bucket
			}
		} as App.Platform;

		const service = await resolveDraftPersistenceService({ platform });
		expect(service).toBeInstanceOf(DraftPersistenceService);
	});

	it('rejects partial Node configuration without exposing its values', async () => {
		privateEnv.DATABASE_URL = 'postgres://sensitive-user:sensitive-password@db/signkit';
		privateEnv.S3_ENDPOINT = 'https://objects.example.com';

		await expect(resolveDraftPersistenceService({})).rejects.toThrow(
			'S3_REGION is required for S3 draft persistence'
		);
	});

	it('constructs PostgreSQL and S3 persistence from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();

		const platform = { req: {} } as unknown as App.Platform;
		const service = await resolveDraftPersistenceService({ platform });
		expect(service).toBeInstanceOf(DraftPersistenceService);
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
