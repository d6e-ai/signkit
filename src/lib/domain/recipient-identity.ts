/**
 * Canonical recipient identity rules shared by envelope readiness and contacts.
 * Deliberately does not apply provider-specific aliases such as Gmail dot or
 * plus removal: SignKit treats the normalized mailbox string as the identity.
 */
export function normalizeRecipientEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function normalizeRecipientName(name: string): string {
	return name.trim();
}

const RECIPIENT_EMAIL_PATTERN: RegExp =
	/^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export function isValidRecipientEmail(email: string): boolean {
	return email.length >= 1 && email.length <= 320 && RECIPIENT_EMAIL_PATTERN.test(email);
}

export function isValidRecipientName(name: string): boolean {
	return name.length >= 1 && name.length <= 200;
}

/**
 * Optional sender-supplied typed-signature suggestion. It is display text only:
 * delivery, identity, and audit always use the recipient email and name.
 */
export function normalizeSignatureDisplayName(name: string): string {
	return name.trim();
}

// Plain text: no C0/C1 control characters (including newlines and tabs).
// eslint-disable-next-line no-control-regex
const SIGNATURE_DISPLAY_NAME_CONTROL_PATTERN: RegExp = /[\u0000-\u001F\u007F-\u009F]/;

export function isValidSignatureDisplayName(name: string): boolean {
	return (
		name.length >= 1 && name.length <= 200 && !SIGNATURE_DISPLAY_NAME_CONTROL_PATTERN.test(name)
	);
}
