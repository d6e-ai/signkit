import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1EnvelopeStore } from '$lib/adapters/db/d1-envelope-store';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveEnvelopeDocumentDependencies } from './envelope-document-dependencies-runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveEnvelopeDocumentDependencies', () => {
	it('returns null when no durable Node configuration exists', async () => {
		await expect(resolveEnvelopeDocumentDependencies({})).resolves.toBeNull();
	});

	it('fails closed on an incomplete Cloudflare binding set without falling back to S3', async () => {
		setCompleteNodeConfiguration();
		const platform = { env: { DB: {} as D1Database } } as App.Platform;

		await expect(resolveEnvelopeDocumentDependencies({ platform })).resolves.toBeNull();
	});

	it('uses native D1 and R2 bindings when both are present', async () => {
		const platform = {
			env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
		} as App.Platform;

		const dependencies = await resolveEnvelopeDocumentDependencies({ platform });
		expect(dependencies).not.toBeNull();
		expect(dependencies?.envelopes).toBeInstanceOf(D1EnvelopeStore);
		expect(dependencies?.repository).toBeInstanceOf(IsomorphicGitDraftRepository);
	});

	it('rejects partial Node configuration without exposing its values', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		privateEnv.S3_ENDPOINT = 'https://objects.example.com';

		await expect(resolveEnvelopeDocumentDependencies({})).rejects.toThrow(
			'S3_REGION is required for S3 draft persistence'
		);
	});

	it('resolves the shared PostgreSQL envelope store and S3 object store from a complete Node configuration', async () => {
		setCompleteNodeConfiguration();

		const dependencies = await resolveEnvelopeDocumentDependencies({});
		expect(dependencies).not.toBeNull();
		expect(dependencies?.repository).toBeInstanceOf(IsomorphicGitDraftRepository);
	});

	it('never imports the DOCX export feature to resolve shared document dependencies', async () => {
		const { readFileSync } = await import('node:fs');
		const source = readFileSync(
			new URL('./envelope-document-dependencies-runtime.ts', import.meta.url),
			'utf8'
		);
		expect(source).not.toContain('docx-export');
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
