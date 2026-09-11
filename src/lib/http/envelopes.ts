import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	CreateEnvelopeResult,
	EnvelopeApplicationPort,
	EnvelopeListPage,
	EnvelopeListQuery,
	EnvelopeRequestActor
} from '$lib/application/envelopes/model';
import type { Envelope } from '$lib/domain/envelope';
import { problemResponse, type ProblemValidationError } from './problem';

const createEnvelopeSchema: ZodType<{ title: string }> = z
	.object({
		title: z.string().trim().min(1).max(200)
	})
	.strict();

const listEnvelopeSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().uuid().optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50)
	})
	.strict();

const envelopeIdSchema: ZodType<string> = z.string().uuid();
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeApplicationResolver = (
	context: ResolverContext
) => EnvelopeApplicationPort | null | Promise<EnvelopeApplicationPort | null>;

export interface EnvelopeHttpHandlers {
	create: RequestHandler;
	get: RequestHandler;
	list: RequestHandler;
}

const MAX_CREATE_BODY_BYTES = 16 * 1024;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CREATE_BODY_BYTES) {
			return { ok: false, reason: 'too_large' };
		}
	}

	if (request.body === null) return { ok: false, reason: 'invalid' };

	const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			totalBytes += result.value.byteLength;
			if (totalBytes > MAX_CREATE_BODY_BYTES) {
				await reader.cancel('request body exceeded the configured limit');
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes: Uint8Array = new Uint8Array(totalBytes);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		const text: string = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function validationErrors(issues: readonly ZodIssue[]): readonly ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => ({
		path: issue.path.length === 0 ? '$' : issue.path.join('.'),
		message: issue.message
	}));
}

function authorizationProblem(
	locals: App.Locals,
	instance: string
): Response | EnvelopeRequestActor {
	if (locals.identityState === 'anonymous') {
		return problemResponse({
			type: 'urn:signkit:problem:authentication-required',
			title: 'Authentication required',
			status: 401,
			detail: 'Sign in before accessing envelopes.',
			instance
		});
	}
	if (locals.identityState === 'no_active_organization') {
		return problemResponse({
			type: 'urn:signkit:problem:organization-required',
			title: 'Active organization required',
			status: 403,
			detail: 'An active organization membership is required.',
			instance
		});
	}
	if (
		locals.identityState !== 'authorized' ||
		locals.principal === null ||
		locals.organizationId === null
	) {
		return problemResponse({
			type: 'urn:signkit:problem:identity-unavailable',
			title: 'Identity unavailable',
			status: 503,
			detail: 'Identity and organization authorization could not be verified.',
			instance
		});
	}
	const membership = locals.memberships.find(
		(candidate) => candidate.organization.id === locals.organizationId
	);
	if (!membership) {
		return problemResponse({
			type: 'urn:signkit:problem:identity-unavailable',
			title: 'Identity unavailable',
			status: 503,
			detail: 'The selected organization membership could not be verified.',
			instance
		});
	}
	return {
		id: locals.principal.subject,
		organizationId: locals.organizationId,
		organizationName: membership.organization.name
	};
}

async function applicationOrUnavailable(
	resolveApplication: EnvelopeApplicationResolver,
	context: ResolverContext,
	instance: string
): Promise<EnvelopeApplicationPort | Response> {
	try {
		const application: EnvelopeApplicationPort | null = await resolveApplication(context);
		if (application !== null) return application;
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event: 'envelope_application_resolution_failed',
				message: error instanceof Error ? error.message : 'unknown error'
			})
		);
	}
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Envelope persistence unavailable',
		status: 503,
		detail: 'The durable envelope store is not configured for this deployment.',
		instance
	});
}

function unexpectedProblem(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'Envelope service unavailable',
		status: 503,
		detail: 'The envelope operation could not be completed.',
		instance
	});
}

export function createEnvelopeHttpHandlers(
	resolveApplication: EnvelopeApplicationResolver
): EnvelopeHttpHandlers {
	const create: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const actor: EnvelopeRequestActor | Response = authorizationProblem(locals, url.pathname);
		if (actor instanceof Response) return actor;

		const idempotencyResult = idempotencyKeySchema.safeParse(
			request.headers.get('idempotency-key')
		);
		if (!idempotencyResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'POST requests require one non-empty Idempotency-Key header.',
				instance: url.pathname,
				errors: validationErrors(idempotencyResult.error.issues)
			});
		}

		const bodyResult: JsonBodyResult = await readJsonBody(request);
		if (!bodyResult.ok && bodyResult.reason === 'too_large') {
			return problemResponse({
				type: 'urn:signkit:problem:request-body-too-large',
				title: 'Request body too large',
				status: 413,
				detail: `The request body must not exceed ${MAX_CREATE_BODY_BYTES} bytes.`,
				instance: url.pathname
			});
		}
		if (!bodyResult.ok) {
			return problemResponse({
				type: 'urn:signkit:problem:invalid-json',
				title: 'Invalid JSON',
				status: 400,
				detail: 'The request body must be valid JSON.',
				instance: url.pathname
			});
		}

		const inputResult = createEnvelopeSchema.safeParse(bodyResult.value);
		if (!inputResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope request did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(inputResult.error.issues)
			});
		}

		const application: EnvelopeApplicationPort | Response = await applicationOrUnavailable(
			resolveApplication,
			{ locals, platform },
			url.pathname
		);
		if (application instanceof Response) return application;

		try {
			const result: CreateEnvelopeResult = await application.create(actor, {
				idempotencyKey: idempotencyResult.data,
				title: inputResult.data.title
			});
			if (result.outcome === 'conflict') {
				return problemResponse({
					type: 'urn:signkit:problem:idempotency-conflict',
					title: 'Idempotency key conflict',
					status: 409,
					detail: 'The Idempotency-Key was already used for a different request.',
					instance: url.pathname
				});
			}

			const headers: Headers = new Headers({
				'cache-control': 'no-store',
				'content-type': 'application/json',
				location: `/api/v1/envelopes/${result.envelope.id}`
			});
			if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
			return new Response(JSON.stringify({ envelope: result.envelope }), {
				status: 201,
				headers
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'envelope_create_failed',
					message: error instanceof Error ? error.message : 'unknown error'
				})
			);
			return unexpectedProblem(url.pathname);
		}
	};

	const list: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
		const actor: EnvelopeRequestActor | Response = authorizationProblem(locals, url.pathname);
		if (actor instanceof Response) return actor;

		const queryResult = listEnvelopeSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!queryResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope list query did not match the required schema.',
				instance: url.pathname,
				errors: validationErrors(queryResult.error.issues)
			});
		}

		const application: EnvelopeApplicationPort | Response = await applicationOrUnavailable(
			resolveApplication,
			{ locals, platform },
			url.pathname
		);
		if (application instanceof Response) return application;

		const query: EnvelopeListQuery = {
			cursor: queryResult.data.cursor ?? null,
			limit: queryResult.data.limit
		};
		try {
			const page: EnvelopeListPage = await application.list(actor, query);
			return new Response(JSON.stringify(page), {
				status: 200,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'envelope_list_failed',
					message: error instanceof Error ? error.message : 'unknown error'
				})
			);
			return unexpectedProblem(url.pathname);
		}
	};

	const get: RequestHandler = async ({ locals, params, platform, url }): Promise<Response> => {
		const actor: EnvelopeRequestActor | Response = authorizationProblem(locals, url.pathname);
		if (actor instanceof Response) return actor;

		const envelopeIdResult = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeIdResult.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-failed',
				title: 'Request validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname,
				errors: validationErrors(envelopeIdResult.error.issues)
			});
		}

		const application: EnvelopeApplicationPort | Response = await applicationOrUnavailable(
			resolveApplication,
			{ locals, platform },
			url.pathname
		);
		if (application instanceof Response) return application;

		try {
			const envelope: Envelope | null = await application.get(actor, envelopeIdResult.data);
			if (envelope === null) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found in the authorized organization.',
					instance: url.pathname
				});
			}
			return new Response(JSON.stringify({ envelope }), {
				status: 200,
				headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'envelope_get_failed',
					message: error instanceof Error ? error.message : 'unknown error'
				})
			);
			return unexpectedProblem(url.pathname);
		}
	};

	return { create, get, list };
}
