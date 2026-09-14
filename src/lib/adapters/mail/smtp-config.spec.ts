import { describe, expect, it } from 'vitest';
import { parseSmtpConfig } from './smtp-config';

describe('parseSmtpConfig', () => {
	it('accepts an explicit implicit-TLS configuration with no auth', () => {
		expect(
			parseSmtpConfig({
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '465',
				SIGNKIT_SMTP_SECURE: 'true'
			})
		).toEqual({ host: 'smtp.example.com', port: 465, secure: true });
	});

	it('accepts an explicit required-STARTTLS configuration', () => {
		expect(
			parseSmtpConfig({
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'false'
			})
		).toEqual({ host: 'smtp.example.com', port: 587, secure: false });
	});

	it('accepts a username and password pair', () => {
		expect(
			parseSmtpConfig({
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'true',
				SIGNKIT_SMTP_USERNAME: 'relay-user',
				SIGNKIT_SMTP_PASSWORD: 'relay-pass'
			})
		).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: true,
			auth: { user: 'relay-user', pass: 'relay-pass' }
		});
	});

	it('trims the host and username but preserves the password exactly', () => {
		expect(
			parseSmtpConfig({
				SIGNKIT_SMTP_HOST: '  smtp.example.com  ',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'true',
				SIGNKIT_SMTP_USERNAME: '  relay-user  ',
				SIGNKIT_SMTP_PASSWORD: '  relay pass with spaces  '
			})
		).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: true,
			auth: { user: 'relay-user', pass: '  relay pass with spaces  ' }
		});
	});

	it('treats an empty password as absent, not as a preserved value', () => {
		expect(
			parseSmtpConfig({
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'true',
				SIGNKIT_SMTP_USERNAME: 'relay-user',
				SIGNKIT_SMTP_PASSWORD: ''
			})
		).toBeNull();
	});

	it.each([
		['missing host', { SIGNKIT_SMTP_PORT: '587', SIGNKIT_SMTP_SECURE: 'true' }],
		[
			'blank host',
			{ SIGNKIT_SMTP_HOST: '   ', SIGNKIT_SMTP_PORT: '587', SIGNKIT_SMTP_SECURE: 'true' }
		],
		['missing port', { SIGNKIT_SMTP_HOST: 'smtp.example.com', SIGNKIT_SMTP_SECURE: 'true' }],
		[
			'non-numeric port',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: 'abc',
				SIGNKIT_SMTP_SECURE: 'true'
			}
		],
		[
			'zero port',
			{ SIGNKIT_SMTP_HOST: 'smtp.example.com', SIGNKIT_SMTP_PORT: '0', SIGNKIT_SMTP_SECURE: 'true' }
		],
		[
			'out-of-range port',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '65536',
				SIGNKIT_SMTP_SECURE: 'true'
			}
		],
		['missing secure flag', { SIGNKIT_SMTP_HOST: 'smtp.example.com', SIGNKIT_SMTP_PORT: '587' }],
		[
			'blank secure flag',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: '   '
			}
		],
		[
			'invalid secure flag',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'yes'
			}
		],
		[
			'username without password',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'true',
				SIGNKIT_SMTP_USERNAME: 'relay-user'
			}
		],
		[
			'password without username',
			{
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'true',
				SIGNKIT_SMTP_PASSWORD: 'relay-pass'
			}
		]
	])('fails closed on %s', (_description, env) => {
		expect(parseSmtpConfig(env)).toBeNull();
	});
});
