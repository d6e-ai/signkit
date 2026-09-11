import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvelopeApplication } from './service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { resolveEnvelopeApplication } from './runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveEnvelopeApplication', () => {
	it('fails closed on a Cloudflare request without D1', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		const platform = { env: {} } as App.Platform;

		await expect(
			resolveEnvelopeApplication({ locals: {} as App.Locals, platform })
		).resolves.toBeNull();
	});

	it('uses D1 when the Cloudflare binding is present', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;

		const application = await resolveEnvelopeApplication({ locals: {} as App.Locals, platform });
		expect(application).toBeInstanceOf(EnvelopeApplication);
	});

	it('uses PostgreSQL for a Node platform that has no Cloudflare env', async () => {
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		const platform = { req: {} } as unknown as App.Platform;

		const application = await resolveEnvelopeApplication({ locals: {} as App.Locals, platform });
		expect(application).toBeInstanceOf(EnvelopeApplication);
	});
});
