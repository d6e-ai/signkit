import nodemailer from 'nodemailer';
import type { NodemailerError, SMTPSentMessageInfo, Transporter } from 'nodemailer';
import {
	MailDeliveryError,
	type MailMessage,
	type MailSender,
	type MailSendReceipt
} from '$lib/ports/mail-sender';
import type { SmtpConfig } from './smtp-config';

const SMTP_CONNECTION_TIMEOUT_MS: number = 20_000;
const SMTP_GREETING_TIMEOUT_MS: number = 20_000;
const SMTP_SOCKET_TIMEOUT_MS: number = 20_000;
const PERMANENT_RESPONSE_CODE_MIN: number = 500;
const PERMANENT_RESPONSE_CODE_MAX: number = 599;

export type SmtpTransporter = Pick<Transporter<SMTPSentMessageInfo>, 'sendMail'>;

export function createSmtpTransporter(config: SmtpConfig): SmtpTransporter {
	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		// Both branches always negotiate TLS: implicit when `secure`, otherwise a
		// mandatory STARTTLS upgrade that aborts the send rather than falling
		// back to plaintext when the server does not offer it.
		requireTLS: !config.secure,
		ignoreTLS: false,
		auth: config.auth,
		// Without this, a server that silently drops its AUTH advertisement
		// would make Nodemailer send unauthenticated instead of failing closed.
		forceAuth: config.auth !== undefined,
		tls: { minVersion: 'TLSv1.2' },
		connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
		greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
		socketTimeout: SMTP_SOCKET_TIMEOUT_MS
	});
}

export class NodemailerSmtpMailSender implements MailSender {
	private readonly transporter: SmtpTransporter;

	constructor(
		config: SmtpConfig,
		transporterFactory: (config: SmtpConfig) => SmtpTransporter = createSmtpTransporter
	) {
		this.transporter = transporterFactory(config);
	}

	async send(message: MailMessage): Promise<MailSendReceipt> {
		let info: SMTPSentMessageInfo;
		try {
			info = await this.transporter.sendMail({
				to: message.to,
				from: { address: message.from.email, name: message.from.name },
				subject: message.subject,
				text: message.text,
				html: message.html
			});
		} catch (error: unknown) {
			throw new MailDeliveryError(smtpErrorCode(error), smtpErrorRetryable(error, message.to));
		}

		if (info.accepted.length === 0) {
			throw new MailDeliveryError('mail_recipient_unconfirmed', true);
		}
		if (typeof info.messageId !== 'string' || info.messageId.trim().length === 0) {
			throw new MailDeliveryError('mail_invalid_response', true);
		}
		return { outcome: 'accepted', providerMessageId: info.messageId };
	}
}

function smtpErrorCode(error: unknown): string {
	const responseCode: number | undefined = numericProperty(error, 'responseCode');
	if (responseCode !== undefined) return `smtp_${responseCode}`;
	const code: string | undefined = stringProperty(error, 'code');
	if (code !== undefined && /^[A-Za-z0-9_]+$/.test(code)) return `smtp_${code.toLowerCase()}`;
	return 'mail_delivery_failed';
}

/**
 * Matches the durable-outbox invariant in
 * docs/architecture/envelope-model.md: provider authentication, sender
 * setup, unknown-provider errors, transport failures, rate limits, and
 * sealing-key drift all remain retryable; only a proven recipient-scoped
 * permanent rejection is terminal. A raw 5xx reply code alone does not prove
 * that — AUTH, MAIL FROM, and DATA can all fail at 5xx for reasons that have
 * nothing to do with the recipient and must stay retryable. Only Nodemailer's
 * `RCPT TO` rejection of this exact recipient, at a permanent (5xx) reply, is
 * treated as terminal.
 */
function smtpErrorRetryable(error: unknown, recipient: string): boolean {
	return !isPermanentRecipientRejection(error, recipient);
}

function isPermanentRecipientRejection(error: unknown, recipient: string): boolean {
	if (stringProperty(error, 'command') !== 'RCPT TO') return false;
	const responseCode: number | undefined = numericProperty(error, 'responseCode');
	if (
		responseCode === undefined ||
		responseCode < PERMANENT_RESPONSE_CODE_MIN ||
		responseCode > PERMANENT_RESPONSE_CODE_MAX
	) {
		return false;
	}
	if (stringArrayProperty(error, 'rejected')?.includes(recipient) === true) return true;
	return stringProperty(error, 'recipient') === recipient;
}

function numericProperty(error: unknown, key: keyof NodemailerError): number | undefined {
	if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
	const value: unknown = (error as Record<string, unknown>)[key];
	return typeof value === 'number' ? value : undefined;
}

function stringProperty(error: unknown, key: keyof NodemailerError): string | undefined {
	if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
	const value: unknown = (error as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}

function stringArrayProperty(error: unknown, key: keyof NodemailerError): string[] | undefined {
	if (typeof error !== 'object' || error === null || !(key in error)) return undefined;
	const value: unknown = (error as Record<string, unknown>)[key];
	if (!Array.isArray(value)) return undefined;
	return value.every((entry: unknown): entry is string => typeof entry === 'string')
		? value
		: undefined;
}
