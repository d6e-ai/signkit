import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionArtifactPublicationService } from './completion-artifact-service';
import { CompletionArtifactStatusService } from './completion-artifact-status';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	resolveCompletionArtifactPublicationService,
	resolveCompletionArtifactStatusService
} from './completion-artifact-runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveCompletionArtifactPublicationService', () => {
	it('returns null when no durable Node configuration exists', async () => {
		await expect(resolveCompletionArtifactPublicationService({})).resolves.toBeNull();
	});

	it('fails closed on an incomplete Cloudflare binding set without falling through to S3', async () => {
		setCompleteNodeConfiguration();
		const platform = { env: { DB: {} as D1Database } } as App.Platform;

		await expect(resolveCompletionArtifactPublicationService({ platform })).resolves.toBeNull();
	});

	it('uses native D1 and R2 bindings when both are present', async () => {
		const platform = {
			env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
		} as App.Platform;

		const service = await resolveCompletionArtifactPublicationService({ platform });
		expect(service).toBeInstanceOf(CompletionArtifactPublicationService);
	});

	// Regression: the Node/S3 path must pass DATABASE_URL through to
	// resolveS3ObjectStore, not just to the PostgreSQL store. Without it,
	// resolveS3ObjectStore's own configuration validation throws
	// "DATABASE_URL is required for S3 draft persistence" before a completion
	// artifact worker ever gets to run.
	it('constructs a PostgreSQL and S3 publication service from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();

		const service = await resolveCompletionArtifactPublicationService({});
		expect(service).toBeInstanceOf(CompletionArtifactPublicationService);
	});
});

describe('resolveCompletionArtifactStatusService', () => {
	it('returns null when no durable Node configuration exists', async () => {
		await expect(resolveCompletionArtifactStatusService({})).resolves.toBeNull();
	});

	it('constructs a PostgreSQL status service from a complete Node configuration', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';

		const service = await resolveCompletionArtifactStatusService({});
		expect(service).toBeInstanceOf(CompletionArtifactStatusService);
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
