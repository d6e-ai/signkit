import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceInvitationApplication } from '$lib/application/instance-invitations/instance-invitation-service';
import type { InstanceInvitationApplicationPort } from '$lib/application/instance-invitations/instance-invitation-service';
import { InstanceMemberApplication } from '$lib/application/instance-members/instance-member-service';
import type { InstanceMemberApplicationPort } from '$lib/application/instance-members/instance-member-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	resolveInstanceInvitationApplication,
	resolveInstanceMemberApplication
} from './instance-runtime';

const TEST_DATABASE_URL: string = 'postgres://signkit:secret@localhost:5432/signkit';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('resolveInstanceInvitationApplication', () => {
	it('returns null when no durable store is configured', async () => {
		await expect(resolveInstanceInvitationApplication({})).resolves.toBeNull();
	});

	it('uses the D1 binding when the Cloudflare platform provides one', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;
		const application: InstanceInvitationApplicationPort | null =
			await resolveInstanceInvitationApplication({ platform });
		expect(application).toBeInstanceOf(InstanceInvitationApplication);
	});

	it('fails closed on a Cloudflare platform without a D1 binding instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveInstanceInvitationApplication({ platform })).resolves.toBeNull();
	});

	it('constructs the PostgreSQL application from DATABASE_URL on Node runtimes', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const application: InstanceInvitationApplicationPort | null =
			await resolveInstanceInvitationApplication({});
		expect(application).toBeInstanceOf(InstanceInvitationApplication);
	});

	it('treats a blank DATABASE_URL as unconfigured', async () => {
		privateEnv.DATABASE_URL = '   ';
		await expect(resolveInstanceInvitationApplication({})).resolves.toBeNull();
	});
});

describe('resolveInstanceMemberApplication', () => {
	it('returns null when no durable store is configured', async () => {
		await expect(resolveInstanceMemberApplication({})).resolves.toBeNull();
	});

	it('uses the D1 binding when the Cloudflare platform provides one', async () => {
		const platform = { env: { DB: {} as D1Database } } as App.Platform;
		const application: InstanceMemberApplicationPort | null =
			await resolveInstanceMemberApplication({ platform });
		expect(application).toBeInstanceOf(InstanceMemberApplication);
	});

	it('fails closed on a Cloudflare platform without a D1 binding instead of using DATABASE_URL', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const platform = { env: {} } as App.Platform;
		await expect(resolveInstanceMemberApplication({ platform })).resolves.toBeNull();
	});

	it('constructs the PostgreSQL application from DATABASE_URL on Node runtimes', async () => {
		privateEnv.DATABASE_URL = TEST_DATABASE_URL;
		const application: InstanceMemberApplicationPort | null =
			await resolveInstanceMemberApplication({});
		expect(application).toBeInstanceOf(InstanceMemberApplication);
	});

	it('treats a blank DATABASE_URL as unconfigured', async () => {
		privateEnv.DATABASE_URL = '   ';
		await expect(resolveInstanceMemberApplication({})).resolves.toBeNull();
	});
});
