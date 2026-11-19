import { timingSafeEqual } from 'node:crypto';

export const sealServiceTokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Compare fixed-size, independently provisioned integration credentials. */
export function authenticated(request: Request, token: string): boolean {
	if (!sealServiceTokenPattern.test(token)) return false;
	const value = request.headers.get('authorization');
	const prefix = 'Bearer ';
	if (value === null || !value.startsWith(prefix)) return false;
	const provided = value.slice(prefix.length);
	return (
		sealServiceTokenPattern.test(provided) &&
		timingSafeEqual(Buffer.from(provided), Buffer.from(token))
	);
}

export function unavailable(status: number): Response {
	return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}
