export const MAIL_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
export const FALLBACK_MAIL_ERROR_CODE: string = 'mail_delivery_failed';

export interface MailAddress {
	email: string;
	name: string;
}

export interface MailMessage {
	to: string;
	from: MailAddress;
	subject: string;
	text: string;
	html: string;
	deliveryKey: string;
}

export type MailSendReceipt =
	{ outcome: 'accepted'; providerMessageId: string } | { outcome: 'queued'; receiptId: string };

export class MailDeliveryError extends Error {
	readonly retryable: boolean;
	readonly code: string;

	constructor(code: string, retryable: boolean) {
		const safeCode: string = sanitizeMailErrorCode(code);
		super(safeCode);
		this.name = 'MailDeliveryError';
		this.retryable = retryable;
		this.code = safeCode;
	}
}

export interface MailSender {
	send(message: MailMessage): Promise<MailSendReceipt>;
}

export function sanitizeMailErrorCode(code: string): string {
	if (MAIL_ERROR_CODE_PATTERN.test(code) && !code.startsWith('skr1_') && !code.startsWith('skdc1_'))
		return code;
	return FALLBACK_MAIL_ERROR_CODE;
}

export function mailProviderReceiptId(receipt: MailSendReceipt): string | null {
	if (receipt.outcome === 'accepted') {
		return boundedReceiptId(receipt.providerMessageId);
	}
	return boundedReceiptId(receipt.receiptId);
}

function boundedReceiptId(value: string): string | null {
	if (value.length === 0 || value.length > 256) return null;
	if (!/^[A-Za-z0-9._:-]+$/.test(value)) return null;
	return value;
}
