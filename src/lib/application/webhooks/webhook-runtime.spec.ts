import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookApplication } from './webhook-service';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { createWebhookAllowedHostsResolver, resolveWebhookApplication } from './webhook-runtime';
import { WEBHOOK_ALLOWED_HOSTS_ENV_VAR } from '$lib/security/webhook-allowed-hosts';

const TEST_ENCRYPTION_KEY: string = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
});

describe('createWebhookAllowedHostsResolver', () => {
	it('resolves null when the variable is absent everywhere', () => {
		expect(createWebhookAllowedHostsResolver(undefined)()).toBeNull();
		expect(createWebhookAllowedHostsResolver({})()).toBeNull();
	});

	it('prefers the platform env over the process env', () => {
		privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] = 'node.example.com';
		const resolve = createWebhookAllowedHostsResolver({
			SIGNKIT_WEBHOOK_ALLOWED_HOSTS: 'worker.example.com'
		});
		const policy = resolve();
		expect(policy).not.toBeNull();
		expect(policy!.exact.has('worker.example.com')).toBe(true);
		expect(policy!.exact.has('node.example.com')).toBe(false);
	});

	it('falls back to the process env on Node', () => {
		privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] = 'hooks.example.com, *.hooks.example.net';
		const policy = createWebhookAllowedHostsResolver(undefined)();
		expect(policy).not.toBeNull();
		expect(policy!.exact.has('hooks.example.com')).toBe(true);
		expect(policy!.suffixes).toEqual(['hooks.example.net']);
	});

	it('re-reads the value on every call', () => {
		const resolve = createWebhookAllowedHostsResolver(undefined);
		expect(resolve()).toBeNull();
		privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] = 'hooks.example.com';
		expect(resolve()!.exact.has('hooks.example.com')).toBe(true);
		delete privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR];
		expect(resolve()).toBeNull();
	});

	it('fails closed to null on an invalid value without echoing it', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] = 'hooks.example.com:8443';
			expect(createWebhookAllowedHostsResolver(undefined)()).toBeNull();
			expect(errorSpy).toHaveBeenCalledOnce();
			expect(JSON.stringify(errorSpy.mock.calls[0])).not.toContain('8443');
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe('resolveWebhookApplication', () => {
	it('returns null without a delivery encryption key', async () => {
		privateEnv[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] = 'hooks.example.com';
		await expect(resolveWebhookApplication({})).resolves.toBeNull();
	});

	it('returns null on Workers without a D1 binding', async () => {
		const platform = {
			env: {
				DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				[WEBHOOK_ALLOWED_HOSTS_ENV_VAR]: 'hooks.example.com'
			}
		} as unknown as App.Platform;
		await expect(resolveWebhookApplication({ platform })).resolves.toBeNull();
	});

	it('constructs an application wired to the deployer allowlist resolver', async () => {
		const platform = {
			env: {
				DB: {} as D1Database,
				DELIVERY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
				[WEBHOOK_ALLOWED_HOSTS_ENV_VAR]: 'hooks.example.com'
			}
		} as unknown as App.Platform;
		const application = await resolveWebhookApplication({ platform });
		expect(application).toBeInstanceOf(WebhookApplication);
	});
});
