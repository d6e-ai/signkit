import { newOpaqueToken } from '$lib/security/opaque-token';
import { WEBHOOK_AUDIT_EVENT_TYPES, isAuditEventType } from '$lib/domain/audit';

export const WEBHOOK_SECRET_PREFIX: string = 'skwh1_';
export const WEBHOOK_SECRET_PATTERN: RegExp = /^skwh1_[A-Za-z0-9_-]{43}$/;
export const WEBHOOK_SECRET_DISPLAY_CHARS: number = 8;
export const WEBHOOK_MAX_ENDPOINTS: number = 20;
export const WEBHOOK_MAX_URL_LENGTH: number = 2000;
export const WEBHOOK_MAX_DESCRIPTION_LENGTH: number = 200;
export const WEBHOOK_MAX_PAYLOAD_BYTES: number = 32 * 1024;
export const WEBHOOK_CLAIM_LEASE_MS: number = 5 * 60 * 1000;
export const WEBHOOK_MAX_ATTEMPTS: number = 10;
export const WEBHOOK_RETRY_BASE_DELAY_MS: number = 30_000;
export const MAX_WEBHOOK_CLAIM_BATCH: number = 25;

export async function hashWebhookSecret(secret: string): Promise<string> {
	if (!WEBHOOK_SECRET_PATTERN.test(secret)) {
		throw new Error('Invalid webhook secret');
	}
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(secret)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

export async function issueWebhookSecret(): Promise<{
	secret: string;
	secretHash: string;
	secretPrefix: string;
}> {
	const secret: string = `${WEBHOOK_SECRET_PREFIX}${newOpaqueToken()}`;
	return {
		secret,
		secretHash: await hashWebhookSecret(secret),
		secretPrefix: secret.slice(0, WEBHOOK_SECRET_PREFIX.length + WEBHOOK_SECRET_DISPLAY_CHARS)
	};
}

export function canonicalizeWebhookEvents(events: readonly string[]): readonly string[] {
	if (events.length === 0) {
		throw new Error('Webhook events must be a nonempty unique subset');
	}
	const seen: Set<string> = new Set<string>();
	for (const eventType of events) {
		if (!isAuditEventType(eventType) || seen.has(eventType)) {
			throw new Error('Webhook events must be a nonempty unique subset of the audit catalog');
		}
		seen.add(eventType);
	}
	return WEBHOOK_AUDIT_EVENT_TYPES.filter((eventType: string): boolean => seen.has(eventType));
}

export async function signWebhookPayload(
	secret: string,
	timestamp: string,
	body: string
): Promise<string> {
	const key: CryptoKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature: ArrayBuffer = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${timestamp}.${body}`)
	);
	const hex: string = Array.from(new Uint8Array(signature), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return `v1=${hex}`;
}
