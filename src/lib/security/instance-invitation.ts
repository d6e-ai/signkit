/**
 * Zero-PII instance invitation tokens and email binding.
 *
 * An invitation token is a `ski1_` bearer credential minted the same way as
 * every other prefixed SignKit credential (`skr1_`, `skca1_`, `signkit_`):
 * the prefix plus 32 cryptographically random bytes, canonical unpadded
 * base64url encoded. Only its SHA-256 `tokenHash` is ever persisted.
 *
 * The invited email address is never stored in plaintext, and no hash of the
 * email alone is stored either — that would let a holder of the database
 * enumerate invited addresses by dictionary or rainbow-table attack. Instead
 * `computeInstanceInvitationEmailBinding` hashes the token together with the
 * normalized email, so the stored `emailBinding` can only be reproduced by
 * someone who already holds the raw token and is asserting a specific
 * address. Acceptance recomputes the binding from the bearer token and the
 * caller-asserted email and compares it to the stored value; it never
 * attempts to recover or index by email.
 */

export const INSTANCE_INVITATION_TOKEN_PREFIX: string = 'ski1_';
export const INSTANCE_INVITATION_TOKEN_SECRET_BYTES: number = 32;
export const INSTANCE_INVITATION_TOKEN_PATTERN: RegExp = /^ski1_[A-Za-z0-9_-]{43}$/;

/** RFC 5321 4.5.3.1.3 overall path length ceiling; a strict, sane upper bound. */
export const INSTANCE_INVITATION_EMAIL_MAX_LENGTH: number = 254;
export const INSTANCE_INVITATION_EMAIL_LOCAL_MAX_LENGTH: number = 64;
export const INSTANCE_INVITATION_EMAIL_DOMAIN_MAX_LENGTH: number = 253;

/** Versioned domain separator for the token/email binding preimage. */
export const INSTANCE_INVITATION_EMAIL_BINDING_DOMAIN: string = 'signkit-instance-invite-email:v1';

export interface IssuedInstanceInvitationToken {
	token: string;
	tokenHash: string;
}

export function isInstanceInvitationToken(value: string): boolean {
	return INSTANCE_INVITATION_TOKEN_PATTERN.test(value);
}

export function parseInstanceInvitationToken(value: string): string {
	if (!isInstanceInvitationToken(value)) {
		throw new Error('Invalid instance invitation token');
	}
	return value;
}

export async function hashInstanceInvitationToken(token: string): Promise<string> {
	const parsed: string = parseInstanceInvitationToken(token);
	return sha256Hex(parsed);
}

export async function issueInstanceInvitationToken(): Promise<IssuedInstanceInvitationToken> {
	const secret: Uint8Array<ArrayBuffer> = new Uint8Array(
		new ArrayBuffer(INSTANCE_INVITATION_TOKEN_SECRET_BYTES)
	);
	crypto.getRandomValues(secret);
	const token: string = `${INSTANCE_INVITATION_TOKEN_PREFIX}${base64UrlEncode(secret)}`;
	return { token, tokenHash: await hashInstanceInvitationToken(token) };
}

/**
 * Trims, applies Unicode NFC normalization, and lowercases the address, then
 * requires exactly one `@` and RFC 5321-shaped local/domain length bounds
 * with no whitespace or control characters. NFC runs before lowercasing so
 * that composed and decomposed encodings of the same visible address (for
 * example a precomposed `é` versus `e` plus a combining acute accent) always
 * normalize to the same canonical string; without it, two byte-distinct but
 * visually identical addresses would bind to different email bindings.
 * Returns the canonical normalized form callers must store and re-derive
 * from; it never accepts an already-normalized value verbatim.
 */
export function normalizeInstanceInvitationEmail(email: string): string {
	const trimmed: string = email.trim().normalize('NFC').toLowerCase();
	if (trimmed.length < 3 || trimmed.length > INSTANCE_INVITATION_EMAIL_MAX_LENGTH) {
		throw new Error('Invalid instance invitation email');
	}
	for (const char of trimmed) {
		const codePoint: number | undefined = char.codePointAt(0);
		if (codePoint === undefined || codePoint < 33 || codePoint === 127) {
			throw new Error('Invalid instance invitation email');
		}
	}
	const atIndex: number = trimmed.indexOf('@');
	if (atIndex === -1 || trimmed.indexOf('@', atIndex + 1) !== -1) {
		throw new Error('Invalid instance invitation email');
	}
	const localPart: string = trimmed.slice(0, atIndex);
	const domainPart: string = trimmed.slice(atIndex + 1);
	if (localPart.length < 1 || localPart.length > INSTANCE_INVITATION_EMAIL_LOCAL_MAX_LENGTH) {
		throw new Error('Invalid instance invitation email');
	}
	if (
		domainPart.length < 1 ||
		domainPart.length > INSTANCE_INVITATION_EMAIL_DOMAIN_MAX_LENGTH ||
		!domainPart.includes('.') ||
		domainPart.startsWith('.') ||
		domainPart.endsWith('.')
	) {
		throw new Error('Invalid instance invitation email');
	}
	return trimmed;
}

/**
 * Binds a token to a normalized email without ever hashing the email alone.
 * `normalizedEmail` must already be this function's own canonical output —
 * anything else (unnormalized casing, padding) is rejected rather than
 * silently re-normalized, so callers cannot accidentally bind and later
 * verify against two different strings.
 */
export async function computeInstanceInvitationEmailBinding(
	token: string,
	normalizedEmail: string
): Promise<string> {
	const parsedToken: string = parseInstanceInvitationToken(token);
	if (normalizeInstanceInvitationEmail(normalizedEmail) !== normalizedEmail) {
		throw new Error('Invalid instance invitation email');
	}
	return sha256Hex(`${INSTANCE_INVITATION_EMAIL_BINDING_DOMAIN}|${parsedToken}|${normalizedEmail}`);
}

async function sha256Hex(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
