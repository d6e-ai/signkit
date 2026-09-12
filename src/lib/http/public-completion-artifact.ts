import type { RequestHandler } from '@sveltejs/kit';
import {
	PublicCompletionArtifactIntegrityError,
	PublicCompletionArtifactNotFoundError,
	PublicCompletionArtifactStorageError,
	type PublicCompletionArtifact,
	type PublicCompletionArtifactFormat,
	type PublicCompletionArtifactService
} from '$lib/application/completion-delivery/public-completion-artifact';
import { isCompletionToken } from '$lib/security/completion-token';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type PublicCompletionArtifactServiceResolver =
	| PublicCompletionArtifactService
	| ((
			context: ResolverContext
	  ) => PublicCompletionArtifactService | null | Promise<PublicCompletionArtifactService | null>);

export interface PublicCompletionArtifactHandlerOptions {
	defaultFormat: PublicCompletionArtifactFormat;
	tokenSource: 'header' | 'param';
	now?: () => Date;
}

const defaultUnconfiguredServiceResolver: PublicCompletionArtifactServiceResolver = () => null;

export function createPublicCompletionArtifactApiHandler(
	resolveService: PublicCompletionArtifactServiceResolver = defaultUnconfiguredServiceResolver,
	now?: () => Date
): RequestHandler {
	return createPublicCompletionArtifactHandler(resolveService, {
		defaultFormat: 'json',
		tokenSource: 'header',
		now
	});
}

export function createPublicCompletionArtifactLinkHandler(
	resolveService: PublicCompletionArtifactServiceResolver = defaultUnconfiguredServiceResolver,
	now?: () => Date
): RequestHandler {
	return createPublicCompletionArtifactHandler(resolveService, {
		defaultFormat: 'markdown',
		tokenSource: 'param',
		now
	});
}

export function createPublicCompletionArtifactHandler(
	resolveService: PublicCompletionArtifactServiceResolver,
	options: PublicCompletionArtifactHandlerOptions
): RequestHandler {
	const now = options.now ?? (() => new Date());
	return async ({ params, platform, request, url }): Promise<Response> => {
		let rawToken: string | null;
		if (options.tokenSource === 'header') {
			rawToken = extractBearerToken(request.headers.get('authorization'));
		} else {
			rawToken = params.token ?? null;
		}

		if (rawToken === null || !isCompletionToken(rawToken)) {
			return opaqueNotFoundResponse();
		}

		const rawFormat = url.searchParams.get('format');
		let format: PublicCompletionArtifactFormat;
		if (rawFormat === null || rawFormat === '') {
			format = options.defaultFormat;
		} else if (rawFormat === 'json' || rawFormat === 'markdown') {
			format = rawFormat;
		} else {
			return opaqueNotFoundResponse();
		}

		let service: PublicCompletionArtifactService | null;
		try {
			service =
				typeof resolveService === 'function' ? await resolveService({ platform }) : resolveService;
		} catch (error: unknown) {
			logError('public_completion_artifact_resolution_failed', error);
			return safeInternalErrorResponse();
		}
		if (service === null) {
			return safeInternalErrorResponse();
		}

		try {
			const artifact: PublicCompletionArtifact = await service.read(rawToken, format, now());
			return new Response(artifact.content, {
				status: 200,
				headers: publicCompletionHeaders(artifact.contentType)
			});
		} catch (error: unknown) {
			if (error instanceof PublicCompletionArtifactNotFoundError) {
				return opaqueNotFoundResponse();
			}
			if (
				error instanceof PublicCompletionArtifactIntegrityError ||
				error instanceof PublicCompletionArtifactStorageError
			) {
				logError('public_completion_artifact_failed', error);
				return safeInternalErrorResponse();
			}
			logError('public_completion_artifact_unexpected_failure', error);
			return safeInternalErrorResponse();
		}
	};
}

function extractBearerToken(authorization: string | null): string | null {
	if (authorization === null || authorization.includes(',')) return null;
	const match: RegExpMatchArray | null = authorization.match(/^Bearer ([^\s]+)$/i);
	return match?.[1] ?? null;
}

function publicCompletionHeaders(contentType: string): Headers {
	const headers = new Headers();
	headers.set('cache-control', 'private, no-store, no-transform');
	headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
	headers.set('content-type', contentType);
	headers.set('referrer-policy', 'no-referrer');
	headers.set('x-content-type-options', 'nosniff');
	return headers;
}

function opaqueNotFoundResponse(): Response {
	return new Response('Not Found', {
		status: 404,
		headers: publicCompletionHeaders('text/plain; charset=utf-8')
	});
}

function safeInternalErrorResponse(): Response {
	return new Response('Internal Server Error', {
		status: 500,
		headers: publicCompletionHeaders('text/plain; charset=utf-8')
	});
}

function logError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			error: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
