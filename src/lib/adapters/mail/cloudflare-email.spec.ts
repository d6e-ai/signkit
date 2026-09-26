import { describe, expect, it, vi } from 'vitest';
import { MailDeliveryError, type MailMessage } from '$lib/ports/mail-sender';
import { CloudflareBindingMailSender, CloudflareRestMailSender } from './cloudflare-email';

const message: MailMessage = {
	to: 'recipient@example.com',
	from: { email: 'sign@example.org', name: 'SignKit' },
	subject: 'Please review',
	text: 'Review the agreement.',
	html: '<p>Review the agreement.</p>',
	deliveryKey: 'delivery-1'
};

describe('Cloudflare email adapters', () => {
	it('uses the Workers builder API with both text and HTML', async () => {
		const send = vi.fn(async (): Promise<EmailSendResult> => ({
			messageId: '<message-1@email.cloudflare.net>'
		}));
		const sender = new CloudflareBindingMailSender({ send } as SendEmail);

		await expect(sender.send(message)).resolves.toEqual({
			outcome: 'accepted',
			providerMessageId: '<message-1@email.cloudflare.net>'
		});
		expect(send).toHaveBeenCalledWith({
			to: message.to,
			from: { email: message.from.email, name: message.from.name },
			subject: message.subject,
			text: message.text,
			html: message.html
		});
	});

	interface SentBuilderOptions {
		attachments?: { disposition: string; filename: string; type: string; content: ArrayBuffer }[];
	}

	it('attaches binary content as an ArrayBuffer through the Workers builder API', async () => {
		const send = vi.fn(async (): Promise<EmailSendResult> => ({
			messageId: '<message-1@email.cloudflare.net>'
		}));
		const sender = new CloudflareBindingMailSender({ send } as unknown as SendEmail);
		const content: Uint8Array = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);

		await sender.send({
			...message,
			attachment: {
				filename: 'signkit-completed-envelope.pdf',
				contentType: 'application/pdf',
				content
			}
		});

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				attachments: [
					{
						disposition: 'attachment',
						filename: 'signkit-completed-envelope.pdf',
						type: 'application/pdf',
						content: expect.any(ArrayBuffer)
					}
				]
			})
		);
		const sentOptions = send.mock.calls[0] as unknown as [SentBuilderOptions];
		const sentAttachment = sentOptions[0].attachments?.[0];
		expect(new Uint8Array(sentAttachment?.content ?? new ArrayBuffer(0))).toEqual(content);
	});

	it('sends no attachments field on the Workers builder API when the message has no attachment', async () => {
		const send = vi.fn(async (): Promise<EmailSendResult> => ({
			messageId: '<message-1@email.cloudflare.net>'
		}));
		const sender = new CloudflareBindingMailSender({ send } as unknown as SendEmail);

		await sender.send(message);

		const sentOptions = send.mock.calls[0] as unknown as [SentBuilderOptions];
		expect(sentOptions[0]).not.toHaveProperty('attachments');
	});

	it('classifies binding errors without retaining provider messages', async () => {
		const send = vi.fn(async (): Promise<EmailSendResult> => {
			throw { code: 'E_RATE_LIMIT_EXCEEDED', message: 'token=secret recipient@example.com' };
		});
		const sender = new CloudflareBindingMailSender({ send } as SendEmail);

		const failure: unknown = await sender.send(message).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(MailDeliveryError);
		expect(failure).toMatchObject({ code: 'e_rate_limit_exceeded', retryable: true });
		expect(String(failure)).not.toMatch(/secret|recipient@example/);
	});

	it.each([
		['E_UNKNOWN', true],
		['E_SENDER_NOT_VERIFIED', true],
		['E_SENDER_DOMAIN_NOT_AVAILABLE', true],
		['E_RECIPIENT_NOT_ALLOWED', true],
		['E_RECIPIENT_SUPPRESSED', false]
	] as const)(
		'classifies binding code %s without destroying recoverable invitations',
		async (code, retryable) => {
			const sender = new CloudflareBindingMailSender({
				send: async (): Promise<EmailSendResult> => {
					throw { code, message: 'provider detail' };
				}
			} as SendEmail);
			await expect(sender.send(message)).rejects.toMatchObject({
				code: code.toLowerCase(),
				retryable
			});
		}
	);

	it('uses REST address fields and returns a stable non-secret receipt', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			Response.json({
				success: true,
				result: { delivered: [message.to], permanent_bounces: [], queued: [] }
			})
		);
		const sender = new CloudflareRestMailSender('a'.repeat(32), 'api-secret', fetchFn);

		await expect(sender.send(message)).resolves.toEqual({
			outcome: 'accepted',
			providerMessageId: 'cf:delivery-1'
		});
		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`
		);
		expect(init?.headers).toEqual({
			authorization: 'Bearer api-secret',
			'content-type': 'application/json'
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			to: message.to,
			from: { address: message.from.email, name: message.from.name },
			subject: message.subject,
			text: message.text,
			html: message.html
		});
	});

	it('base64-encodes attachment content in the REST JSON body', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			Response.json({
				success: true,
				result: { delivered: [message.to], permanent_bounces: [], queued: [] }
			})
		);
		const sender = new CloudflareRestMailSender('a'.repeat(32), 'api-secret', fetchFn);
		const content: Uint8Array = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);

		await sender.send({
			...message,
			attachment: {
				filename: 'signkit-completed-envelope.pdf',
				contentType: 'application/pdf',
				content
			}
		});

		const [, init] = fetchFn.mock.calls[0];
		const body: { attachments: { filename: string; type: string; content: string }[] } = JSON.parse(
			String(init?.body)
		);
		expect(body.attachments).toEqual([
			{
				filename: 'signkit-completed-envelope.pdf',
				type: 'application/pdf',
				content: Buffer.from(content).toString('base64')
			}
		]);
	});

	it('sends no attachments field over REST when the message has no attachment', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () =>
			Response.json({
				success: true,
				result: { delivered: [message.to], permanent_bounces: [], queued: [] }
			})
		);
		const sender = new CloudflareRestMailSender('a'.repeat(32), 'api-secret', fetchFn);

		await sender.send(message);

		const [, init] = fetchFn.mock.calls[0];
		expect(JSON.parse(String(init?.body))).not.toHaveProperty('attachments');
	});

	it.each([
		[429, true, 'mail_rate_limited'],
		[503, true, 'mail_http_503'],
		[400, true, 'mail_http_400'],
		[401, true, 'mail_http_401'],
		[403, true, 'mail_http_403']
	] as const)('classifies REST status %i', async (status, retryable, code) => {
		const sender = new CloudflareRestMailSender(
			'a'.repeat(32),
			'api-secret',
			async (): Promise<Response> => new Response('provider details', { status })
		);
		const failure: unknown = await sender.send(message).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code, retryable });
		expect(String(failure)).not.toContain('provider details');
	});

	it('treats a permanent bounce as non-retryable', async () => {
		const sender = new CloudflareRestMailSender(
			'a'.repeat(32),
			'api-secret',
			async (): Promise<Response> =>
				Response.json({
					success: true,
					result: { delivered: [], permanent_bounces: [message.to], queued: [] }
				})
		);
		await expect(sender.send(message)).rejects.toMatchObject({
			code: 'recipient_rejected',
			retryable: false
		});
	});
});
