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
