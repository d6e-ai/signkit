import {
	MailDeliveryError,
	type MailMessage,
	type MailSender,
	type MailSendReceipt
} from '$lib/ports/mail-sender';

const ACCOUNT_ID_PATTERN: RegExp = /^[a-f0-9]{32}$/;
const REST_SEND_TIMEOUT_MS: number = 20_000;
const PERMANENT_RECIPIENT_BINDING_CODES: ReadonlySet<string> = new Set(['E_RECIPIENT_SUPPRESSED']);

export class CloudflareBindingMailSender implements MailSender {
	constructor(private readonly binding: SendEmail) {}

	async send(message: MailMessage): Promise<MailSendReceipt> {
		try {
			const result: EmailSendResult = await this.binding.send({
				to: message.to,
				from: { email: message.from.email, name: message.from.name },
				subject: message.subject,
				text: message.text,
				html: message.html,
				...(message.attachment === undefined
					? {}
					: {
							attachments: [
								{
									disposition: 'attachment',
									filename: message.attachment.filename,
									type: message.attachment.contentType,
									content: toArrayBuffer(message.attachment.content)
								}
							]
						})
			});
			return { outcome: 'accepted', providerMessageId: result.messageId };
		} catch (error: unknown) {
			const code: string = bindingErrorCode(error);
			throw new MailDeliveryError(
				bindingDeliveryCode(code),
				!PERMANENT_RECIPIENT_BINDING_CODES.has(code)
			);
		}
	}
}

interface CloudflareRestResult {
	delivered?: unknown;
	permanent_bounces?: unknown;
	queued?: unknown;
}

interface CloudflareRestEnvelope {
	success?: unknown;
	result?: CloudflareRestResult | null;
}

export class CloudflareRestMailSender implements MailSender {
	readonly #endpoint: string;

	constructor(
		accountId: string,
		private readonly apiToken: string,
		private readonly fetchFn: typeof fetch = fetch
	) {
		const normalizedAccountId: string = accountId.trim().toLowerCase();
		if (!ACCOUNT_ID_PATTERN.test(normalizedAccountId)) {
			throw new Error('CLOUDFLARE_EMAIL_ACCOUNT_ID must be a 32-character hexadecimal ID');
		}
		if (apiToken.trim().length === 0) {
			throw new Error('CLOUDFLARE_EMAIL_API_TOKEN is required');
		}
		this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${normalizedAccountId}/email/sending/send`;
	}

	async send(message: MailMessage): Promise<MailSendReceipt> {
		let response: Response;
		try {
			response = await this.fetchFn(this.#endpoint, {
				method: 'POST',
				signal: AbortSignal.timeout(REST_SEND_TIMEOUT_MS),
				headers: {
					authorization: `Bearer ${this.apiToken}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					to: message.to,
					from: { address: message.from.email, name: message.from.name },
					subject: message.subject,
					text: message.text,
					html: message.html,
					...(message.attachment === undefined
						? {}
						: {
								attachments: [
									{
										filename: message.attachment.filename,
										type: message.attachment.contentType,
										content: base64Encode(message.attachment.content)
									}
								]
							})
				})
			});
		} catch {
			throw new MailDeliveryError('mail_network_error', true);
		}

		if (!response.ok) {
			throw new MailDeliveryError(
				response.status === 429 ? 'mail_rate_limited' : `mail_http_${response.status}`,
				true
			);
		}

		const envelope: CloudflareRestEnvelope | null = await parseRestEnvelope(response);
		if (envelope === null || envelope.success !== true || envelope.result === null) {
			throw new MailDeliveryError('mail_invalid_response', true);
		}
		const delivered: readonly string[] = stringArray(envelope.result?.delivered);
		const queued: readonly string[] = stringArray(envelope.result?.queued);
		const bounced: readonly string[] = stringArray(envelope.result?.permanent_bounces);
		if (bounced.includes(message.to)) {
			throw new MailDeliveryError('recipient_rejected', false);
		}
		if (delivered.includes(message.to)) {
			return { outcome: 'accepted', providerMessageId: `cf:${message.deliveryKey}` };
		}
		if (queued.includes(message.to)) {
			return { outcome: 'queued', receiptId: `cf:${message.deliveryKey}` };
		}
		throw new MailDeliveryError('mail_recipient_unconfirmed', true);
	}
}

function bindingErrorCode(error: unknown): string {
	if (typeof error !== 'object' || error === null || !('code' in error)) return 'E_UNKNOWN';
	const code: unknown = error.code;
	return typeof code === 'string' ? code : 'E_UNKNOWN';
}

function bindingDeliveryCode(code: string): string {
	return /^E_[A-Z0-9_]+$/.test(code) ? code.toLowerCase() : 'mail_binding_error';
}

async function parseRestEnvelope(response: Response): Promise<CloudflareRestEnvelope | null> {
	try {
		const body: unknown = await response.json();
		return typeof body === 'object' && body !== null ? (body as CloudflareRestEnvelope) : null;
	} catch {
		return null;
	}
}

function stringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry: unknown): entry is string => typeof entry === 'string');
}

/**
 * Copies into a right-sized `ArrayBuffer` rather than returning `bytes.buffer`
 * directly, since a `Uint8Array` view (for example, one produced by
 * `subarray`) can share a larger backing buffer whose bounds do not match its
 * own `byteOffset`/`byteLength`.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

const BASE64_CHUNK_SIZE: number = 0x8000;

/** Chunked to avoid a call-stack blowout from `String.fromCharCode(...bytes)` on a large PDF. */
function base64Encode(bytes: Uint8Array): string {
	let binary: string = '';
	for (let offset: number = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_SIZE) {
		const chunk: Uint8Array = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}
