import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	PublicCompletionArtifactIntegrityError,
	PublicCompletionArtifactNotFoundError,
	PublicCompletionArtifactStorageError,
	type PublicCompletionArtifact,
	type PublicCompletionArtifactFormat,
	type PublicCompletionArtifactService
} from '$lib/application/completion-delivery/public-completion-artifact';
import { issueCompletionToken } from '$lib/security/completion-token';
import {
	createPublicCompletionArtifactApiHandler,
	createPublicCompletionArtifactHandler,
	createPublicCompletionArtifactLinkHandler,
	type PublicCompletionArtifactServiceResolver
} from './public-completion-artifact';

const NOW: Date = new Date('2026-09-12T12:00:00.000Z');
const SECRET_ORG_ID: string = '01900000-0000-7000-8000-000000000001';
const SECRET_ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000002';
const SECRET_OBJECT_KEY: string =
	'completion-artifacts/v1/organizations/secret/envelopes/secret/sha256/abc.json.gz';
const SECRET_TOKEN_HASH: string =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SECRET_EMAIL: string = 'signer@example.com';
const SECRET_NAME: string = 'Jane Doe';
const SECRET_PROVIDER: string = 'cloudflare-email';

function mockService(
	reader: (
		token: string,
		format: PublicCompletionArtifactFormat,
		at: Date
	) => Promise<PublicCompletionArtifact>
): PublicCompletionArtifactService {
	return {
		read: vi.fn(reader)
	} as unknown as PublicCompletionArtifactService;
}

function apiEvent(authorization?: string, query?: string): RequestEvent {
	const url = new URL(
		`https://signkit.example/api/v1/completion-artifacts${query ? `?${query}` : ''}`
	);
	const headers = new Headers();
	if (authorization !== undefined) {
		headers.set('authorization', authorization);
	}
	return {
		locals: {} as App.Locals,
		params: {},
		platform: { env: {} },
		request: new Request(url, { headers }),
		url
	} as unknown as RequestEvent;
}

function linkEvent(token?: string, query?: string): RequestEvent {
	const pathname = token !== undefined ? `/c/${token}` : '/c/';
	const url = new URL(`https://signkit.example${pathname}${query ? `?${query}` : ''}`);
	return {
		locals: {} as App.Locals,
		params: token !== undefined ? { token } : {},
		platform: { env: {} },
		request: new Request(url),
		url
	} as unknown as RequestEvent;
}

describe('Public Completion Artifact HTTP Handlers', () => {
	describe('valid formats and defaults', () => {
		it('GET /api/v1/completion-artifacts defaults to json format', async () => {
			const issued = await issueCompletionToken();
			const jsonBody = JSON.stringify({ schema: 'signkit-completion-manifest-v1' });
			const service = mockService(async (token, format, at) => {
				expect(token).toBe(issued.token);
				expect(format).toBe('json');
				expect(at).toEqual(NOW);
				return { content: jsonBody, contentType: 'application/json' };
			});

			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);
			const response = await handler(apiEvent(`Bearer ${issued.token}`));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(await response.text()).toBe(jsonBody);
		});

		it('GET /api/v1/completion-artifacts?format=json serves json format', async () => {
			const issued = await issueCompletionToken();
			const jsonBody = JSON.stringify({ schema: 'signkit-completion-manifest-v1' });
			const service = mockService(async (_token, format) => {
				expect(format).toBe('json');
				return { content: jsonBody, contentType: 'application/json' };
			});

			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);
			const response = await handler(apiEvent(`Bearer ${issued.token}`, 'format=json'));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(await response.text()).toBe(jsonBody);
		});

		it('GET /api/v1/completion-artifacts?format=markdown serves markdown format', async () => {
			const issued = await issueCompletionToken();
			const markdownBody = '# Completion evidence';
			const service = mockService(async (_token, format) => {
				expect(format).toBe('markdown');
				return { content: markdownBody, contentType: 'text/markdown' };
			});

			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);
			const response = await handler(apiEvent(`Bearer ${issued.token}`, 'format=markdown'));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('text/markdown');
			expect(await response.text()).toBe(markdownBody);
		});

		it('GET /c/[token] defaults to markdown format', async () => {
			const issued = await issueCompletionToken();
			const markdownBody = '# Completion evidence';
			const service = mockService(async (token, format, at) => {
				expect(token).toBe(issued.token);
				expect(format).toBe('markdown');
				expect(at).toEqual(NOW);
				return { content: markdownBody, contentType: 'text/markdown' };
			});

			const handler = createPublicCompletionArtifactLinkHandler(service, () => NOW);
			const response = await handler(linkEvent(issued.token));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('text/markdown');
			expect(await response.text()).toBe(markdownBody);
		});

		it('GET /c/[token]?format=markdown serves markdown format', async () => {
			const issued = await issueCompletionToken();
			const markdownBody = '# Completion evidence';
			const service = mockService(async (_token, format) => {
				expect(format).toBe('markdown');
				return { content: markdownBody, contentType: 'text/markdown' };
			});

			const handler = createPublicCompletionArtifactLinkHandler(service, () => NOW);
			const response = await handler(linkEvent(issued.token, 'format=markdown'));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('text/markdown');
			expect(await response.text()).toBe(markdownBody);
		});

		it('GET /c/[token]?format=json serves json format', async () => {
			const issued = await issueCompletionToken();
			const jsonBody = JSON.stringify({ schema: 'signkit-completion-manifest-v1' });
			const service = mockService(async (_token, format) => {
				expect(format).toBe('json');
				return { content: jsonBody, contentType: 'application/json' };
			});

			const handler = createPublicCompletionArtifactLinkHandler(service, () => NOW);
			const response = await handler(linkEvent(issued.token, 'format=json'));

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('application/json');
			expect(await response.text()).toBe(jsonBody);
		});
	});

	describe('security headers and cookie isolation', () => {
		it('sets required security headers and never sets or leaks Set-Cookie on 200, 404, and 500', async () => {
			const issued = await issueCompletionToken();
			const service = mockService(async (_token, format) => {
				if (format === 'json') return { content: '{}', contentType: 'application/json' };
				throw new PublicCompletionArtifactIntegrityError();
			});

			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);

			// 200 response
			const res200 = await handler(apiEvent(`Bearer ${issued.token}`, 'format=json'));
			expect(res200.status).toBe(200);
			expect(res200.headers.get('cache-control')).toBe('private, no-store, no-transform');
			expect(res200.headers.get('referrer-policy')).toBe('no-referrer');
			expect(res200.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res200.headers.get('content-security-policy')).toBe(
				"default-src 'none'; frame-ancestors 'none'"
			);
			expect(res200.headers.get('set-cookie')).toBeNull();

			// 404 response
			const res404 = await handler(apiEvent(undefined));
			expect(res404.status).toBe(404);
			expect(res404.headers.get('cache-control')).toBe('private, no-store, no-transform');
			expect(res404.headers.get('referrer-policy')).toBe('no-referrer');
			expect(res404.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res404.headers.get('content-security-policy')).toBe(
				"default-src 'none'; frame-ancestors 'none'"
			);
			expect(res404.headers.get('set-cookie')).toBeNull();

			// 500 response
			const res500 = await handler(apiEvent(`Bearer ${issued.token}`, 'format=markdown'));
			expect(res500.status).toBe(500);
			expect(res500.headers.get('cache-control')).toBe('private, no-store, no-transform');
			expect(res500.headers.get('referrer-policy')).toBe('no-referrer');
			expect(res500.headers.get('x-content-type-options')).toBe('nosniff');
			expect(res500.headers.get('content-security-policy')).toBe(
				"default-src 'none'; frame-ancestors 'none'"
			);
			expect(res500.headers.get('set-cookie')).toBeNull();
		});
	});

	describe('cross-purpose skr1 token rejection', () => {
		it('rejects skr1 recipient tokens with opaque 404 on API route', async () => {
			const service = mockService(async () => {
				throw new Error('should not be called');
			});
			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);
			const skr1Token = `skr1_${'x'.repeat(43)}`;

			const response = await handler(apiEvent(`Bearer ${skr1Token}`));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not Found');
			expect(service.read).not.toHaveBeenCalled();
		});

		it('rejects skr1 recipient tokens with opaque 404 on link route', async () => {
			const service = mockService(async () => {
				throw new Error('should not be called');
			});
			const handler = createPublicCompletionArtifactLinkHandler(service, () => NOW);
			const skr1Token = `skr1_${'x'.repeat(43)}`;

			const response = await handler(linkEvent(skr1Token));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not Found');
			expect(service.read).not.toHaveBeenCalled();
		});
	});

	describe('missing or malformed auth', () => {
		const invalidAuthCases: [string | undefined, string][] = [
			[undefined, 'missing authorization header'],
			['Basic dXNlcjpwYXNz', 'non-Bearer scheme'],
			['Bearer', 'missing token material'],
			['Bearer ', 'empty token material'],
			[`Bearer ${'a'.repeat(43)}`, 'missing skca1 prefix'],
			[`Bearer skca1_short`, 'token too short'],
			[`Bearer skca1_${'a'.repeat(43)}, Bearer skca1_${'b'.repeat(43)}`, 'multiple tokens']
		];

		for (const [auth, label] of invalidAuthCases) {
			it(`returns opaque 404 for ${label}`, async () => {
				const service = mockService(async () => {
					throw new Error('should not be called');
				});
				const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);

				const response = await handler(apiEvent(auth));
				expect(response.status).toBe(404);
				expect(await response.text()).toBe('Not Found');
				expect(service.read).not.toHaveBeenCalled();
			});
		}
	});

	describe('inactive resolver and invalid format handling', () => {
		it('returns opaque 404 when the store resolver reports inactive or expired token', async () => {
			const issued = await issueCompletionToken();
			const service = mockService(async () => {
				throw new PublicCompletionArtifactNotFoundError();
			});
			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);

			const response = await handler(apiEvent(`Bearer ${issued.token}`));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not Found');
		});

		it('returns opaque 404 when an invalid format parameter is requested', async () => {
			const issued = await issueCompletionToken();
			const service = mockService(async () => ({
				content: 'ok',
				contentType: 'text/plain'
			}));
			const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);

			for (const badFormat of ['xml', 'pdf', 'html', 'json;charset=utf-8']) {
				const response = await handler(apiEvent(`Bearer ${issued.token}`, `format=${badFormat}`));
				expect(response.status).toBe(404);
				expect(await response.text()).toBe('Not Found');
				expect(service.read).not.toHaveBeenCalled();
			}
		});

		it('returns opaque 404 when link route is invoked without a token', async () => {
			const service = mockService(async () => ({
				content: 'ok',
				contentType: 'text/plain'
			}));
			const handler = createPublicCompletionArtifactLinkHandler(service, () => NOW);

			const response = await handler(linkEvent(undefined));
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not Found');
			expect(service.read).not.toHaveBeenCalled();
		});
	});

	describe('integrity and storage failure to safe 500 mapping', () => {
		const failureCases: [string, Error][] = [
			['key or digest mismatch', new PublicCompletionArtifactIntegrityError()],
			['missing object in store', new PublicCompletionArtifactIntegrityError()],
			['oversized input gzip', new PublicCompletionArtifactIntegrityError()],
			['decompression bomb', new PublicCompletionArtifactIntegrityError()],
			['non-UTF-8 bytes', new PublicCompletionArtifactIntegrityError()],
			['wrong manifest schema', new PublicCompletionArtifactIntegrityError()],
			['storage failure', new PublicCompletionArtifactStorageError()],
			['generic storage error', new Error('Underlying network failure')]
		];

		for (const [label, error] of failureCases) {
			it(`returns safe 500 on ${label}`, async () => {
				const issued = await issueCompletionToken();
				const service = mockService(async () => {
					throw error;
				});
				const handler = createPublicCompletionArtifactApiHandler(service, () => NOW);

				const response = await handler(apiEvent(`Bearer ${issued.token}`));
				expect(response.status).toBe(500);
				expect(await response.text()).toBe('Internal Server Error');
				expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
			});
		}

		it('returns safe 500 when service resolver function returns null', async () => {
			const issued = await issueCompletionToken();
			const resolver: PublicCompletionArtifactServiceResolver = () => null;
			const handler = createPublicCompletionArtifactApiHandler(resolver, () => NOW);

			const response = await handler(apiEvent(`Bearer ${issued.token}`));
			expect(response.status).toBe(500);
			expect(await response.text()).toBe('Internal Server Error');
		});

		it('returns safe 500 when service resolver function throws', async () => {
			const issued = await issueCompletionToken();
			const resolver: PublicCompletionArtifactServiceResolver = () => {
				throw new Error('Resolver bootstrap failed');
			};
			const handler = createPublicCompletionArtifactApiHandler(resolver, () => NOW);

			const response = await handler(apiEvent(`Bearer ${issued.token}`));
			expect(response.status).toBe(500);
			expect(await response.text()).toBe('Internal Server Error');
		});
	});

	describe('zero metadata exposure across all responses', () => {
		it('does not leak internal tenant IDs, envelope IDs, object keys, hashes, emails, names, or providers', async () => {
			const issued = await issueCompletionToken();
			const sensitiveStrings = [
				SECRET_ORG_ID,
				SECRET_ENVELOPE_ID,
				SECRET_OBJECT_KEY,
				SECRET_TOKEN_HASH,
				SECRET_EMAIL,
				SECRET_NAME,
				SECRET_PROVIDER
			];

			// Check 404
			const notFoundHandler = createPublicCompletionArtifactApiHandler(() => null);
			const res404 = await notFoundHandler(apiEvent(undefined));
			const body404 = await res404.text();
			const headers404 = JSON.stringify([...res404.headers.entries()]);
			for (const secret of sensitiveStrings) {
				expect(body404).not.toContain(secret);
				expect(headers404).not.toContain(secret);
			}

			// Check 500
			const errorHandler = createPublicCompletionArtifactApiHandler(
				mockService(async () => {
					throw new Error(
						`Failed for ${SECRET_ORG_ID}:${SECRET_ENVELOPE_ID} at ${SECRET_OBJECT_KEY} with ${SECRET_EMAIL}`
					);
				})
			);
			const res500 = await errorHandler(apiEvent(`Bearer ${issued.token}`));
			const body500 = await res500.text();
			const headers500 = JSON.stringify([...res500.headers.entries()]);
			for (const secret of sensitiveStrings) {
				expect(body500).not.toContain(secret);
				expect(headers500).not.toContain(secret);
			}
		});
	});

	describe('createPublicCompletionArtifactHandler base factory', () => {
		it('supports configurable defaultFormat and tokenSource', async () => {
			const issued = await issueCompletionToken();
			const service = mockService(async () => ({
				content: 'custom-content',
				contentType: 'text/markdown'
			}));
			const handler = createPublicCompletionArtifactHandler(service, {
				defaultFormat: 'markdown',
				tokenSource: 'header',
				now: () => NOW
			});
			const response = await handler(apiEvent(`Bearer ${issued.token}`));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('custom-content');
		});
	});
});
