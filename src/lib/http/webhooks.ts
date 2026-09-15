import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InvalidWebhookRequestError,
	type CreateWebhookResult,
	type RevokeWebhookResult,
	type WebhookApplicationPort,
	type WebhookRequestActor
} from '$lib/application/webhooks/webhook-service';
import { WEBHOOK_AUDIT_EVENT_TYPES } from '$lib/domain/audit';
import { DEFAULT_WEBHOOK_LIST_LIMIT, MAX_WEBHOOK_LIST_LIMIT } from '$lib/ports/webhook-store';
import { WebhookHostNotAllowedError } from '$lib/security/webhook-allowed-hosts';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { signkitIdentifierSchema } from './identifier-schema';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_CREATE_BODY_BYTES: number = 8 * 1024;
const MAX_REVOKE_BODY_BYTES: number = 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

const createWebhookSchema: ZodType<{
	url: string;
	description?: string | null;
	events: readonly string[];
}> = z
	.object({
		url: z.string().min(12).max(2000),
		description: z.union([z.string().max(200), z.null()]).optional(),
		events: z
			.array(z.enum(WEBHOOK_AUDIT_EVENT_TYPES as [string, ...string[]]))
			.min(1)
			.max(20)
	})
	.strict();

const listSchema: ZodType<{ cursor?: string; limit: number }> = z
	.object({
		cursor: z.string().min(1).max(200).optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_WEBHOOK_LIST_LIMIT)
			.default(DEFAULT_WEBHOOK_LIST_LIMIT)
	})
	.strict();

const revokeSchema = z.object({}).strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type WebhookApplicationResolver = (
	context: ResolverContext
) => WebhookApplicationPort | null | Promise<WebhookApplicationPort | null>;

export interface WebhookHttpHandlers {
	create: RequestHandler;
	list: RequestHandler;
	get: RequestHandler;
	revoke: RequestHandler;
	deliveries: RequestHandler;
}

export function createWebhookHttpHandlers(
	resolveApplication: WebhookApplicationResolver
): WebhookHttpHandlers {
	const create: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOperator(locals, url.pathname);
		if (authorized instanceof Response) return authorized;
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success)
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);
		const body: JsonBodyResult = await readJsonBody(request, MAX_CREATE_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_CREATE_BODY_BYTES)
				: invalidJson(url.pathname);
		}
		const parsed = createWebhookSchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The webhook creation request did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}
		const application: WebhookApplicationPort | Response = await resolveOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'webhook_create_resolution_failed'
		);
		if (application instanceof Response) return application;
		try {
			const result: CreateWebhookResult = await application.createEndpoint(actorOf(authorized), {
				idempotencyKey: idempotencyKey.data,
				url: parsed.data.url,
				description: parsed.data.description ?? null,
				events: parsed.data.events
			});
			return createResponse(result, url.pathname);
		} catch (error: unknown) {
			if (
				error instanceof InvalidWebhookRequestError ||
				error instanceof WebhookHostNotAllowedError ||
				error instanceof WebhookTargetRejectedError
			) {
				return validationFailed(url.pathname, error.message, [
					{ path: 'url', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({ event: 'webhook_create_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const list: RequestHandler = async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOperator(locals, url.pathname);
		if (authorized instanceof Response) return authorized;
		const parsed = listSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The webhook list query did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}
		const application: WebhookApplicationPort | Response = await resolveOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'webhook_list_resolution_failed'
		);
		if (application instanceof Response) return application;
		try {
			const page = await application.listEndpoints(actorOf(authorized), {
				cursor: parsed.data.cursor ?? null,
				limit: parsed.data.limit
			});
			return Response.json(page, { headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			console.error(JSON.stringify({ event: 'webhook_list_failed', message: errorMessage(error) }));
			return serviceUnavailable(url.pathname);
		}
	};

	const get: RequestHandler = async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOperator(locals, url.pathname);
		if (authorized instanceof Response) return authorized;
		const webhookId = signkitIdentifierSchema.safeParse(params.webhookId);
		if (!webhookId.success) return notFound(url.pathname);
		const application: WebhookApplicationPort | Response = await resolveOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'webhook_get_resolution_failed'
		);
		if (application instanceof Response) return application;
		try {
			const endpoint = await application.getEndpoint(actorOf(authorized), webhookId.data);
			if (endpoint === null) return notFound(url.pathname);
			return Response.json(
				{ webhook: publicWebhook(endpoint) },
				{ headers: { 'cache-control': 'no-store' } }
			);
		} catch (error: unknown) {
			console.error(JSON.stringify({ event: 'webhook_get_failed', message: errorMessage(error) }));
			return serviceUnavailable(url.pathname);
		}
	};

	const revoke: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOperator(locals, url.pathname);
		if (authorized instanceof Response) return authorized;
		const webhookId = signkitIdentifierSchema.safeParse(params.webhookId);
		if (!webhookId.success) return notFound(url.pathname);
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success)
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);
		const body: JsonBodyResult = await readJsonBody(request, MAX_REVOKE_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_REVOKE_BODY_BYTES)
				: invalidJson(url.pathname);
		}
		if (!revokeSchema.safeParse(body.value).success) {
			return validationFailed(url.pathname, 'Revoke commands require an empty JSON object.', [
				{ path: '$', message: 'Revoke commands require an empty JSON object.' }
			]);
		}
		const application: WebhookApplicationPort | Response = await resolveOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'webhook_revoke_resolution_failed'
		);
		if (application instanceof Response) return application;
		try {
			const result: RevokeWebhookResult = await application.revokeEndpoint(
				actorOf(authorized),
				webhookId.data,
				idempotencyKey.data
			);
			return revokeResponse(result, url.pathname);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'webhook_revoke_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	const deliveries: RequestHandler = async ({
		locals,
		params,
		platform,
		url
	}): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOperator(locals, url.pathname);
		if (authorized instanceof Response) return authorized;
		const webhookId = signkitIdentifierSchema.safeParse(params.webhookId);
		if (!webhookId.success) return notFound(url.pathname);
		const parsed = listSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The webhook delivery list query did not match the required schema.',
				validationErrors(parsed.error.issues)
			);
		}
		const application: WebhookApplicationPort | Response = await resolveOrProblem(
			resolveApplication,
			{ platform },
			url.pathname,
			'webhook_deliveries_resolution_failed'
		);
		if (application instanceof Response) return application;
		try {
			const page = await application.listDeliveryLogs(actorOf(authorized), webhookId.data, {
				cursor: parsed.data.cursor ?? null,
				limit: parsed.data.limit
			});
			if (page === null) return notFound(url.pathname);
			return Response.json(page, { headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'webhook_deliveries_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};

	return { create, list, get, revoke, deliveries };
}

function authorizeOperator(
	locals: App.Locals,
	instance: string
): AuthorizedRequestActor | Response {
	const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
		locals,
		instance
	);
	if (authorized instanceof Response) return authorized;
	if (authorized.organizationRole !== 'owner' && authorized.organizationRole !== 'admin') {
		return problemResponse({
			type: 'urn:signkit:problem:webhook-forbidden',
			title: 'Webhook management forbidden',
			status: 403,
			detail: 'Webhook endpoints can be managed only by organization owners and admins.',
			instance
		});
	}
	return authorized;
}

function actorOf(authorized: AuthorizedRequestActor): WebhookRequestActor {
	return { id: authorized.id, organizationId: authorized.organizationId };
}

function publicWebhook(endpoint: {
	id: string;
	organizationId: string;
	url: string;
	description: string | null;
	status: string;
	events: readonly string[];
	secretPrefix: string;
	createdAt: string;
	createdByUserId: string;
	revokedAt: string | null;
	revokedByUserId: string | null;
}): Record<string, unknown> {
	return {
		id: endpoint.id,
		organizationId: endpoint.organizationId,
		url: endpoint.url,
		description: endpoint.description,
		status: endpoint.status,
		events: endpoint.events,
		secretPrefix: endpoint.secretPrefix,
		createdAt: endpoint.createdAt,
		createdByUserId: endpoint.createdByUserId,
		revokedAt: endpoint.revokedAt,
		revokedByUserId: endpoint.revokedByUserId
	};
}

function createResponse(result: CreateWebhookResult, instance: string): Response {
	if (result.outcome === 'created') {
		return Response.json(
			{ webhook: publicWebhook(result.endpoint), secret: result.secret },
			{ status: 201, headers: { 'cache-control': 'no-store' } }
		);
	}
	if (result.outcome === 'replayed') {
		return Response.json(
			{ webhook: publicWebhook(result.endpoint) },
			{ status: 200, headers: { 'cache-control': 'no-store', 'idempotency-replayed': 'true' } }
		);
	}
	if (result.outcome === 'limit_exceeded') {
		return problemResponse({
			type: 'urn:signkit:problem:webhook-limit-exceeded',
			title: 'Webhook endpoint limit exceeded',
			status: 409,
			detail: 'This organization already has the maximum number of webhook endpoints.',
			instance
		});
	}
	return problemResponse({
		type: 'urn:signkit:problem:idempotency-conflict',
		title: 'Idempotency key conflict',
		status: 409,
		detail: 'The Idempotency-Key was already used for a different webhook request.',
		instance
	});
}

function revokeResponse(result: RevokeWebhookResult, instance: string): Response {
	if (result.outcome === 'revoked' || result.outcome === 'replayed') {
		const headers: HeadersInit = { 'cache-control': 'no-store' };
		if (result.outcome === 'replayed') {
			return Response.json(
				{ webhook: publicWebhook(result.endpoint) },
				{ headers: { ...headers, 'idempotency-replayed': 'true' } }
			);
		}
		return Response.json({ webhook: publicWebhook(result.endpoint) }, { headers });
	}
	if (result.outcome === 'not_found') return notFound(instance);
	return problemResponse({
		type: 'urn:signkit:problem:idempotency-conflict',
		title: 'Idempotency key conflict',
		status: 409,
		detail: 'The Idempotency-Key was already used for a different webhook request.',
		instance
	});
}

async function resolveOrProblem(
	resolveApplication: WebhookApplicationResolver,
	context: ResolverContext,
	instance: string,
	event: string
): Promise<WebhookApplicationPort | Response> {
	let application: WebhookApplicationPort | null;
	try {
		application = await resolveApplication(context);
	} catch (error: unknown) {
		console.error(JSON.stringify({ event, message: errorMessage(error) }));
		application = null;
	}
	return application === null ? persistenceUnavailable(instance) : application;
}

function validationFailed(
	instance: string,
	detail: string,
	errors: readonly ProblemValidationError[]
): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-failed',
		title: 'Request validation failed',
		status: 400,
		detail,
		instance,
		errors
	});
}

function idempotencyKeyRequired(instance: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:idempotency-key-required',
		title: 'Valid Idempotency-Key required',
		status: 400,
		detail: 'POST requests require one non-empty visible-ASCII Idempotency-Key header.',
		instance,
		errors: validationErrors(issues)
	});
}

function unsupportedMediaType(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:unsupported-media-type',
		title: 'Unsupported media type',
		status: 415,
		detail: 'This endpoint requires an application/json request body.',
		instance
	});
}

function invalidJson(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:invalid-json',
		title: 'Invalid JSON',
		status: 400,
		detail: 'The request body must be valid JSON.',
		instance
	});
}

function bodyTooLarge(instance: string, maxBytes: number): Response {
	return problemResponse({
		type: 'urn:signkit:problem:request-body-too-large',
		title: 'Request body too large',
		status: 413,
		detail: `The request body must not exceed ${maxBytes} bytes.`,
		instance
	});
}

function persistenceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Webhook persistence unavailable',
		status: 503,
		detail: 'The durable webhook store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'Webhook service unavailable',
		status: 503,
		detail: 'The webhook operation could not be completed.',
		instance
	});
}

function notFound(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:webhook-not-found',
		title: 'Webhook not found',
		status: 404,
		detail: 'No webhook endpoint was found in the authorized organization.',
		instance
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}
