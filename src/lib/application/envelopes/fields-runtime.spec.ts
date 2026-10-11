import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvelopeAuthoringFieldsRead, EnvelopeFieldApplication } from './fields';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
const resolveDraftPersistenceService = vi.hoisted(() => vi.fn());

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));
vi.mock('$lib/application/drafts/runtime', () => ({ resolveDraftPersistenceService }));

import {
	resolveEnvelopeAuthoringFieldsRead,
	resolveEnvelopeFieldApplication
} from './fields-runtime';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	resolveDraftPersistenceService.mockReset();
});

describe('resolveEnvelopeFieldApplication', () => {
	it('fails closed when draft persistence is unavailable', async () => {
		resolveDraftPersistenceService.mockResolvedValue(null);
		await expect(resolveEnvelopeFieldApplication({ locals: {} as App.Locals })).resolves.toBeNull();
	});

	it('fails closed on a Cloudflare request without D1', async () => {
		resolveDraftPersistenceService.mockResolvedValue({});
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit';
		const platform = { env: { OBJECTS: {} as R2Bucket } } as App.Platform;

		await expect(
			resolveEnvelopeFieldApplication({ locals: {} as App.Locals, platform })
		).resolves.toBeNull();
	});

	it('uses D1 with the already-resolved Cloudflare draft persistence service', async () => {
		const drafts = {};
		resolveDraftPersistenceService.mockResolvedValue(drafts);
		const platform = {
			env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
		} as App.Platform;

		const application = await resolveEnvelopeFieldApplication({
			locals: {} as App.Locals,
			platform
		});
		expect(application).toBeInstanceOf(EnvelopeFieldApplication);
		expect(resolveDraftPersistenceService).toHaveBeenCalledOnce();
	});

	it('uses PostgreSQL for a Node platform with durable draft persistence', async () => {
		resolveDraftPersistenceService.mockResolvedValue({});
		privateEnv.DATABASE_URL = 'postgres://signkit:secret@localhost:5432/signkit-fields';
		const platform = { req: {} } as unknown as App.Platform;

		const application = await resolveEnvelopeFieldApplication({
			locals: {} as App.Locals,
			platform
		});
		expect(application).toBeInstanceOf(EnvelopeFieldApplication);
		expect(resolveDraftPersistenceService).toHaveBeenCalledOnce();
	});
});

describe('resolveEnvelopeAuthoringFieldsRead', () => {
	it('fails closed on a Cloudflare request without D1 and does not require draft persistence', async () => {
		const platform = { env: { OBJECTS: {} as R2Bucket } } as App.Platform;
		await expect(
			resolveEnvelopeAuthoringFieldsRead({ locals: {} as App.Locals, platform })
		).resolves.toBeNull();
		expect(resolveDraftPersistenceService).not.toHaveBeenCalled();
	});

	it('uses D1 without resolving Git draft persistence', async () => {
		const platform = {
			env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket }
		} as App.Platform;
		const read = await resolveEnvelopeAuthoringFieldsRead({
			locals: {} as App.Locals,
			platform
		});
		expect(read).toBeInstanceOf(EnvelopeAuthoringFieldsRead);
		expect(resolveDraftPersistenceService).not.toHaveBeenCalled();
	});
});
