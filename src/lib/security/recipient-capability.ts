const TOKEN_PREFIX = 'skr1_';
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^skr1_[A-Za-z0-9_-]{43}$/;

export interface IssuedRecipientCapability {
	token: string;
	tokenHash: string;
}

export async function issueRecipientCapability(): Promise<IssuedRecipientCapability> {
	const secret: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(TOKEN_BYTES));
	crypto.getRandomValues(secret);
	const token: string = `${TOKEN_PREFIX}${base64UrlEncode(secret)}`;
	return { token, tokenHash: await hashRecipientCapability(token) };
}

export async function hashRecipientCapability(token: string): Promise<string> {
	if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token)
	);
	return [...new Uint8Array(digest)]
		.map((byte: number): string => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function isRecipientCapability(value: string): boolean {
	return TOKEN_PATTERN.test(value);
}

export function recipientSigningPath(token: string): `/s/${string}` {
	if (!isRecipientCapability(token)) throw new Error('Invalid recipient capability token');
	return `/s/${token}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary: string = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
