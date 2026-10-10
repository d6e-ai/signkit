import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailDeliveryError, type MailMessage } from '$lib/ports/mail-sender';
import { NodemailerSmtpMailSender, type SmtpTransporter } from './smtp';
import type { SmtpConfig } from './smtp-config';

const message: MailMessage = {
	to: 'recipient@example.com',
	from: { email: 'sign@example.org', name: 'SignKit' },
	subject: 'Please review',
	text: 'Review the agreement.',
	html: '<p>Review the agreement.</p>',
	deliveryKey: 'delivery-1'
};

const config: SmtpConfig = {
	host: 'smtp.example.com',
	port: 587,
	secure: false,
	auth: { user: 'relay-user', pass: 'relay-secret' }
};

function senderWith(transporter: SmtpTransporter): NodemailerSmtpMailSender {
	return new NodemailerSmtpMailSender(config, () => transporter);
}

describe('NodemailerSmtpMailSender', () => {
	it('passes the transporter factory the resolved SMTP configuration', () => {
		const factory = vi.fn(() => ({ sendMail: vi.fn() }) as unknown as SmtpTransporter);
		new NodemailerSmtpMailSender(config, factory);
		expect(factory).toHaveBeenCalledWith(config);
	});

	it('returns an accepted receipt with the provider message ID', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [message.to],
			rejected: [],
			messageId: '<abc123@smtp.example.com>'
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).resolves.toEqual({
			outcome: 'accepted',
			providerMessageId: '<abc123@smtp.example.com>'
		});
		expect(sendMail).toHaveBeenCalledWith({
			to: message.to,
			from: { address: message.from.email, name: message.from.name },
			subject: message.subject,
			text: message.text,
			html: message.html
		});
	});

	interface SentMailOptions {
		attachments?: { filename: string; contentType: string; content: Buffer }[];
	}

	it('passes an attachment through as a byte-preserving Buffer with its content type', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [message.to],
			rejected: [],
			messageId: '<abc123@smtp.example.com>'
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);
		const content: Uint8Array = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xff, 0x00]);

		await sender.send({
			...message,
			attachment: {
				filename: 'signkit-completed-envelope.pdf',
				contentType: 'application/pdf',
				content
			}
		});

		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [
					expect.objectContaining({
						filename: 'signkit-completed-envelope.pdf',
						contentType: 'application/pdf'
					})
				]
			})
		);
		const sentOptions = sendMail.mock.calls[0] as unknown as [SentMailOptions];
		const sentAttachment = sentOptions[0].attachments?.[0];
		expect(Buffer.isBuffer(sentAttachment?.content)).toBe(true);
		expect(Uint8Array.from(sentAttachment?.content ?? [])).toEqual(content);
	});

	it('preserves attachment bytes when the source array is a view into a larger buffer', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [message.to],
			rejected: [],
			messageId: '<abc123@smtp.example.com>'
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);
		const backing = new Uint8Array([0xaa, 0x01, 0x02, 0x03, 0x04, 0xbb]);
		const view = backing.subarray(1, 5);

		await sender.send({
			...message,
			attachment: { filename: 'view.pdf', contentType: 'application/pdf', content: view }
		});

		const sentOptions = sendMail.mock.calls[0] as unknown as [SentMailOptions];
		const sentAttachment = sentOptions[0].attachments?.[0];
		expect(Uint8Array.from(sentAttachment?.content ?? [])).toEqual(
			Uint8Array.from([0x01, 0x02, 0x03, 0x04])
		);
	});

	it('sends no attachments field when the message has no attachment', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [message.to],
			rejected: [],
			messageId: '<abc123@smtp.example.com>'
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await sender.send(message);

		const sentOptions = sendMail.mock.calls[0] as unknown as [SentMailOptions];
		expect(sentOptions[0]).not.toHaveProperty('attachments');
	});

	it('treats a resolved empty accepted list as retryable, since it proves no permanent rejection', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [],
			rejected: [message.to],
			messageId: '<abc123@smtp.example.com>'
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'mail_recipient_unconfirmed',
			retryable: true
		});
	});

	it('fails closed on a missing provider message ID', async () => {
		const sendMail = vi.fn(async () => ({
			accepted: [message.to],
			rejected: [],
			messageId: ''
		}));
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'mail_invalid_response',
			retryable: true
		});
	});

	it('treats a 535 AUTH failure as retryable, never terminal', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Invalid login: 535 authentication failed'), {
				code: 'EAUTH',
				command: 'AUTH PLAIN',
				responseCode: 535
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_535',
			retryable: true
		});
	});

	it('treats a missing-credentials EAUTH failure with no responseCode as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Missing credentials for "PLAIN"'), {
				code: 'EAUTH',
				command: 'API'
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_eauth',
			retryable: true
		});
	});

	it('treats an ENOAUTH failure as retryable, never terminal', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Server did not advertise AUTH'), { code: 'ENOAUTH' });
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_enoauth',
			retryable: true
		});
	});

	it('treats a 550 MAIL FROM (sender setup) failure as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Mail command failed: 550 sender rejected'), {
				code: 'EENVELOPE',
				command: 'MAIL FROM',
				responseCode: 550,
				response: '550 sender rejected'
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_550',
			retryable: true
		});
	});

	it('treats a 550 DATA (content policy) failure as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Data command failed: 550 message rejected'), {
				code: 'EENVELOPE',
				command: 'DATA',
				responseCode: 550,
				response: '550 message rejected'
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_550',
			retryable: true
		});
	});

	it('treats a proven 550 RCPT TO rejection of the target recipient as terminal', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(
				new Error("Can't send mail - all recipients were rejected: 550 no such user"),
				{
					code: 'EENVELOPE',
					command: 'RCPT TO',
					responseCode: 550,
					response: '550 no such user',
					rejected: [message.to],
					rejectedErrors: [
						Object.assign(new Error('Recipient command failed: 550 no such user'), {
							code: 'EENVELOPE',
							command: 'RCPT TO',
							responseCode: 550,
							recipient: message.to
						})
					]
				}
			);
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_550',
			retryable: false
		});
	});

	it('treats a RCPT TO rejection of a different recipient as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error("Can't send mail - all recipients were rejected"), {
				code: 'EENVELOPE',
				command: 'RCPT TO',
				responseCode: 550,
				rejected: ['someone-else@example.com']
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_550',
			retryable: true
		});
	});

	it('treats a RCPT TO rejection at a temporary (4xx) code as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error("Can't send mail - all recipients were rejected"), {
				code: 'EENVELOPE',
				command: 'RCPT TO',
				responseCode: 450,
				rejected: [message.to]
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_450',
			retryable: true
		});
	});

	it('treats a per-recipient RCPT TO rejection error (recipient field, no rejected array) as terminal', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Recipient command failed: 550 no such user'), {
				code: 'EENVELOPE',
				command: 'RCPT TO',
				responseCode: 550,
				recipient: message.to
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_550',
			retryable: false
		});
	});

	it('treats a connection-level failure without a reply code as retryable', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), {
				code: 'ECONNECTION'
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_econnection',
			retryable: true
		});
	});

	it('permits underscores in Nodemailer machine codes such as EAI_AGAIN', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('getaddrinfo EAI_AGAIN smtp.example.com'), {
				code: 'EAI_AGAIN'
			});
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'smtp_eai_again',
			retryable: true
		});
	});

	it('falls back to a generic code when no recognizable machine code is present', async () => {
		const sendMail = vi.fn(async () => {
			throw new Error('totally unexpected failure');
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'mail_delivery_failed',
			retryable: true
		});
	});

	it('never leaks the raw provider error, credentials, or recipient address', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(
				new Error(`535 authentication failed for relay-user:relay-secret sending to ${message.to}`),
				{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }
			);
		});
		const sender = senderWith({ sendMail } as unknown as SmtpTransporter);

		const failure: unknown = await sender.send(message).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MailDeliveryError);
		expect(String(failure)).not.toMatch(/relay-secret|relay-user|recipient@example\.com/);
		expect(JSON.stringify(failure)).not.toMatch(/relay-secret|relay-user|recipient@example\.com/);
	});
});

describe('createSmtpTransporter', () => {
	afterEach(() => {
		vi.doUnmock('nodemailer');
		vi.resetModules();
	});

	async function capturedOptions(smtpConfig: SmtpConfig): Promise<Record<string, unknown>> {
		const createTransport = vi.fn<(options: Record<string, unknown>) => unknown>();
		vi.doMock('nodemailer', () => ({ default: { createTransport } }));
		vi.resetModules();
		const { createSmtpTransporter } = await import('./smtp');
		createSmtpTransporter(smtpConfig);
		expect(createTransport).toHaveBeenCalledTimes(1);
		return createTransport.mock.calls[0][0] as Record<string, unknown>;
	}

	it('configures implicit TLS, timeouts, and no forced auth when secure and unauthenticated', async () => {
		const options = await capturedOptions({ host: 'smtp.example.com', port: 465, secure: true });
		expect(options).toMatchObject({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			requireTLS: false,
			ignoreTLS: false,
			forceAuth: false,
			tls: { minVersion: 'TLSv1.2' },
			connectionTimeout: 20_000,
			greetingTimeout: 20_000,
			socketTimeout: 20_000
		});
	});

	it('configures mandatory STARTTLS, the TLS 1.2 floor, and forced auth when authenticated', async () => {
		const options = await capturedOptions({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			auth: { user: 'relay-user', pass: 'relay-secret' }
		});
		expect(options).toMatchObject({
			secure: false,
			requireTLS: true,
			ignoreTLS: false,
			auth: { user: 'relay-user', pass: 'relay-secret' },
			forceAuth: true,
			tls: { minVersion: 'TLSv1.2' }
		});
	});
});
