import { describe, expect, it } from 'vitest';
import {
	CloudflareBindingMailSender,
	CloudflareRestMailSender
} from '$lib/adapters/mail/cloudflare-email';
import { NodemailerSmtpMailSender } from '$lib/adapters/mail/smtp';
import { parseMailProvider, resolveNodeMailSender, resolveWorkerMailSender } from './mail-runtime';

describe('parseMailProvider', () => {
	it('accepts exactly smtp and cloudflare, case-insensitively', () => {
		expect(parseMailProvider('smtp')).toBe('smtp');
		expect(parseMailProvider('CLOUDFLARE')).toBe('cloudflare');
		expect(parseMailProvider(' cloudflare ')).toBe('cloudflare');
	});

	it.each([undefined, '', 'resend', 'ses', 'mailgun', 'sendgrid'])(
		'rejects %s',
		(value: string | undefined) => {
			expect(parseMailProvider(value)).toBeNull();
		}
	);
});

describe('resolveWorkerMailSender', () => {
	it('fails closed when the provider is unset', async () => {
		await expect(resolveWorkerMailSender({}, {} as SendEmail)).resolves.toBeNull();
	});

	it('fails closed when smtp is selected with incomplete configuration', async () => {
		await expect(
			resolveWorkerMailSender(
				{ SIGNKIT_MAIL_PROVIDER: 'smtp', SIGNKIT_SMTP_HOST: 'smtp.example.com' },
				undefined
			)
		).resolves.toBeNull();
	});

	it('fails closed when Workers SMTP is configured on prohibited port 25', async () => {
		await expect(
			resolveWorkerMailSender(
				{
					SIGNKIT_MAIL_PROVIDER: 'smtp',
					SIGNKIT_SMTP_HOST: 'smtp.example.com',
					SIGNKIT_SMTP_PORT: '25',
					SIGNKIT_SMTP_SECURE: 'false'
				},
				undefined
			)
		).resolves.toBeNull();
	});

	it('returns an SMTP sender on Workers without an EMAIL binding', async () => {
		const sender = await resolveWorkerMailSender(
			{
				SIGNKIT_MAIL_PROVIDER: 'smtp',
				SIGNKIT_SMTP_HOST: 'smtp.example.com',
				SIGNKIT_SMTP_PORT: '587',
				SIGNKIT_SMTP_SECURE: 'false'
			},
			undefined
		);
		expect(sender).toBeInstanceOf(NodemailerSmtpMailSender);
	});

	it('fails closed when cloudflare is selected but the EMAIL binding is missing', async () => {
		await expect(
			resolveWorkerMailSender({ SIGNKIT_MAIL_PROVIDER: 'cloudflare' }, undefined)
		).resolves.toBeNull();
	});

	it('returns a binding sender when cloudflare is selected and the EMAIL binding is present', async () => {
		const sender = await resolveWorkerMailSender(
			{ SIGNKIT_MAIL_PROVIDER: 'cloudflare' },
			{} as SendEmail
		);
		expect(sender).toBeInstanceOf(CloudflareBindingMailSender);
	});
});

describe('resolveNodeMailSender', () => {
	it('fails closed when the provider is unset or invalid', async () => {
		await expect(resolveNodeMailSender({})).resolves.toBeNull();
		await expect(resolveNodeMailSender({ SIGNKIT_MAIL_PROVIDER: 'resend' })).resolves.toBeNull();
	});

	it('fails closed when cloudflare is selected but credentials are incomplete', async () => {
		await expect(
			resolveNodeMailSender({
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				CLOUDFLARE_EMAIL_ACCOUNT_ID: '0123456789abcdef0123456789abcdef'
			})
		).resolves.toBeNull();
	});

	it('fails closed when cloudflare account ID is malformed', async () => {
		await expect(
			resolveNodeMailSender({
				SIGNKIT_MAIL_PROVIDER: 'cloudflare',
				CLOUDFLARE_EMAIL_ACCOUNT_ID: 'not-a-valid-account-id',
				CLOUDFLARE_EMAIL_API_TOKEN: 'token'
			})
		).resolves.toBeNull();
	});

	it('returns a REST sender when cloudflare is selected with complete credentials', async () => {
		const sender = await resolveNodeMailSender({
			SIGNKIT_MAIL_PROVIDER: 'cloudflare',
			CLOUDFLARE_EMAIL_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
			CLOUDFLARE_EMAIL_API_TOKEN: 'token'
		});
		expect(sender).toBeInstanceOf(CloudflareRestMailSender);
	});

	it('fails closed when smtp is selected but the SMTP configuration is incomplete', async () => {
		await expect(
			resolveNodeMailSender({
				SIGNKIT_MAIL_PROVIDER: 'smtp',
				SIGNKIT_SMTP_HOST: 'smtp.example.com'
			})
		).resolves.toBeNull();
	});

	it('returns an SMTP sender when smtp is selected with a complete configuration', async () => {
		const sender = await resolveNodeMailSender({
			SIGNKIT_MAIL_PROVIDER: 'smtp',
			SIGNKIT_SMTP_HOST: 'smtp.example.com',
			SIGNKIT_SMTP_PORT: '587',
			SIGNKIT_SMTP_SECURE: 'false'
		});
		expect(sender).toBeInstanceOf(NodemailerSmtpMailSender);
	});

	it('supports Resend as an ordinary SMTP relay, with no Resend-specific configuration', async () => {
		const sender = await resolveNodeMailSender({
			SIGNKIT_MAIL_PROVIDER: 'smtp',
			SIGNKIT_SMTP_HOST: 'smtp.resend.com',
			SIGNKIT_SMTP_PORT: '465',
			SIGNKIT_SMTP_SECURE: 'true',
			SIGNKIT_SMTP_USERNAME: 'resend',
			SIGNKIT_SMTP_PASSWORD: 're_api_key'
		});
		expect(sender).toBeInstanceOf(NodemailerSmtpMailSender);
	});
});
