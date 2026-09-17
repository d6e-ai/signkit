import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from '../src/cli/effective-config.js';
import { parseArgv } from '../src/cli/parse.js';
import { renderWranglerConfig } from '../src/providers/cloudflare/config.js';
import {
	parseInitialSecretStdinBytes,
	SMTP_RECOVERY_SECRET_NAME
} from '../src/recovery/bootstrap.js';
import { ACCOUNT_ID, sampleManifest } from './helpers.js';

const baseConfig = {
	workerName: 'signkit',
	d1Name: 'signkit',
	d1Id: '11111111-1111-1111-1111-111111111111',
	r2Name: 'signkit-objects',
	manifest: sampleManifest(),
	main: 'worker/index.js',
	assetsDirectory: 'assets',
	migrationsDirectory: 'migrations/d1'
};

describe('Cloudflare mail provider selection', () => {
	it('defaults to the native Cloudflare EMAIL binding', () => {
		const parsed = parseArgv(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID]);
		expect(parsed).toMatchObject({ mailProvider: 'cloudflare' });
		const config = JSON.parse(
			renderWranglerConfig({ ...baseConfig, mailProvider: 'cloudflare' })
		) as Record<string, unknown>;
		expect(config.send_email).toEqual([{ name: 'EMAIL' }]);
		expect(config.vars).toMatchObject({ SIGNKIT_MAIL_PROVIDER: 'cloudflare' });
	});

	it('renders bounded SMTP vars without an EMAIL binding and requires only the password secret', () => {
		const parsed = parseArgv([
			'--cloudflare',
			'plan',
			'--account-id',
			ACCOUNT_ID,
			'--mail-provider',
			'smtp',
			'--smtp-host',
			'smtp.example.com',
			'--smtp-port',
			'587',
			'--smtp-secure',
			'false',
			'--smtp-username',
			'relay-user'
		]);
		expect(parsed).toMatchObject({
			mailProvider: 'smtp',
			smtpHost: 'smtp.example.com',
			smtpPort: 587,
			smtpSecure: false,
			smtpUsername: 'relay-user'
		});
		const config = JSON.parse(
			renderWranglerConfig({
				...baseConfig,
				mailProvider: 'smtp',
				smtpHost: 'smtp.example.com',
				smtpPort: 587,
				smtpSecure: false,
				smtpUsername: 'relay-user'
			})
		) as Record<string, unknown>;
		expect(config).not.toHaveProperty('send_email');
		expect(config.vars).toMatchObject({
			SIGNKIT_MAIL_PROVIDER: 'smtp',
			SIGNKIT_SMTP_HOST: 'smtp.example.com',
			SIGNKIT_SMTP_PORT: '587',
			SIGNKIT_SMTP_SECURE: 'false',
			SIGNKIT_SMTP_USERNAME: 'relay-user'
		});
		expect(config.secrets).toMatchObject({
			required: expect.arrayContaining([SMTP_RECOVERY_SECRET_NAME])
		});
	});

	it('inherits the SMTP provider before applying an explicit connection override', () => {
		const parsed = parseArgv([
			'--cloudflare',
			'upgrade',
			'--account-id',
			ACCOUNT_ID,
			'--smtp-host',
			'smtp-new.example.com'
		]);
		const effective = resolveEffectiveConfig(parsed, {
			schemaVersion: 1,
			provider: 'cloudflare',
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			d1: { name: 'signkit' },
			r2: { name: 'signkit-objects' },
			mailProvider: 'smtp',
			smtpHost: 'smtp-old.example.com',
			smtpPort: 587,
			smtpSecure: false,
			bootstrapOwnerEmail: 'owner@example.com',
			channel: 'stable',
			updatedAt: '2026-09-17T00:00:00.000Z'
		});

		expect(effective).toMatchObject({
			mailProvider: 'smtp',
			smtpHost: 'smtp-new.example.com',
			smtpPort: 587,
			smtpSecure: false
		});
	});

	it('rejects port 25 and all password argv while accepting the password only in bounded stdin JSON', () => {
		expect(() =>
			parseArgv([
				'--cloudflare',
				'plan',
				'--account-id',
				ACCOUNT_ID,
				'--mail-provider',
				'smtp',
				'--smtp-port',
				'25'
			])
		).toThrow(/other than 25/);
		expect(() =>
			parseArgv([
				'--cloudflare',
				'plan',
				'--account-id',
				ACCOUNT_ID,
				'--smtp-password',
				'do-not-print'
			])
		).toThrow(/never accepted on argv/);
		const secret = parseInitialSecretStdinBytes(
			new TextEncoder().encode(
				JSON.stringify({
					D6E_AUTH_CLIENT_ID: 'client-id',
					D6E_AUTH_CLIENT_SECRET: 'client-secret',
					SIGNKIT_SMTP_PASSWORD: ' exact password bytes '
				})
			),
			true
		);
		expect(secret.SIGNKIT_SMTP_PASSWORD).toBe(' exact password bytes ');
	});
});
