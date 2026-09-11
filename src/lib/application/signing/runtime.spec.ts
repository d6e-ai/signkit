import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipientAccessService } from './recipient-access';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveRecipientAccessApplication } from './runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

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
