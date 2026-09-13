import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import type {
	RecipientCapabilityReissueApplicationPort,
	ReissueRecipientCapabilityInput,
	ReissueRecipientCapabilityResult
} from '$lib/application/signing/recipient-capability-reissue';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BODY_BYTES: number = 4 * 1024;
const identifierSchema: ZodType<string> = signkitIdentifierSchema;
const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

const reissueBodySchema = z
	.object({
		recipientId: identifierSchema.optional(),
		reason: z.string().max(500).optional()
	})
	.strict();

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export type EnvelopeReissueApplicationResolver = (
	context: ResolverContext
) =>
	| RecipientCapabilityReissueApplicationPort
	| null
	| Promise<RecipientCapabilityReissueApplicationPort | null>;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; reason: 'invalid' | 'too_large' };

export function createEnvelopeReissueHandler(
	resolveApplication: EnvelopeReissueApplicationResolver
): RequestHandler {
	return async ({ locals, params, platform, request, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		const envelopeId = identifierSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) {
			return validationProblem(
				url.pathname,
				'The envelope ID must be a valid UUID.',
				envelopeId.error.issues
			);
		}

		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyRequired(url.pathname, idempotencyKey.error.issues);
		}
		if (!acceptsJson(request)) return unsupportedMediaType(url.pathname);

		const body: JsonBodyResult = await readJsonBody(request);
		if (!body.ok) {
			return body.reason === 'too_large' ? bodyTooLarge(url.pathname) : invalidJson(url.pathname);
		}

		const parsed = reissueBodySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationProblem(
				url.pathname,
				'The reissue command did not match the required schema.',
				parsed.error.issues
			);
		}

		const recipientIdString: string | undefined = params.recipientId ?? parsed.data.recipientId;
		if (recipientIdString === undefined) {
			return validationProblem(url.pathname, 'A valid recipient ID must be provided.', [
				{
					code: z.ZodIssueCode.custom,
					message: 'recipientId is required',
					path: ['recipientId']
				}
			]);
		}
		const recipientId = identifierSchema.safeParse(recipientIdString);
		if (!recipientId.success) {
			return validationProblem(
				url.pathname,
				'The recipient ID must be a valid UUID.',
				recipientId.error.issues
			);
		}

		let application: RecipientCapabilityReissueApplicationPort | null;
		try {
			application = await resolveApplication({ locals, platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'envelope_reissue_resolution_failed',
					message: errorMessage(error)
				})
			);
			application = null;
		}
		if (application === null) return persistenceUnavailable(url.pathname);

		const actor: EnvelopeRequestActor = {
			id: authorized.id,
			organizationId: authorized.organizationId,
			organizationName: authorized.organizationName
		};

		const input: ReissueRecipientCapabilityInput = {
			envelopeId: envelopeId.data,
			recipientId: recipientId.data,
			idempotencyKey: idempotencyKey.data,
			reason: parsed.data.reason
		};

		try {
			const result: ReissueRecipientCapabilityResult = await application.reissue(actor, input);
			return reissueResponse(result, url.pathname);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({ event: 'envelope_reissue_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};
}

function reissueResponse(result: ReissueRecipientCapabilityResult, instance: string): Response {
	if (result.outcome === 'published' || result.outcome === 'replayed') {
		const headers: Headers = new Headers({
			'cache-control': 'no-store',
			'content-type': 'application/json'
		});
		if (result.outcome === 'replayed') headers.set('idempotency-replayed', 'true');
		return new Response(
			JSON.stringify({
				reissued: {
					envelopeId: result.result.envelopeId,
					recipientId: result.result.recipientId,
					reissuedAt: result.result.reissuedAt
				}
			}),
			{ status: 200, headers }
		);
	}
	if (result.outcome === 'not_found') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:envelope-not-found',
				title: 'Envelope or recipient not found',
				status: 404,
				detail: 'The specified envelope or recipient does not exist in this organization.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'not_eligible') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:recipient-reissue-not-eligible',
				title: 'Recipient not eligible for reissue',
				status: 409,
				detail: `Recipient is not eligible for capability reissue: ${result.reason}.`,
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'delivery_in_flight') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:delivery-in-flight',
				title: 'Delivery in flight',
				status: 409,
				detail:
					'A delivery attempt is currently in flight for this recipient. Please retry shortly.',
				instance
			},
			securityHeaders({ 'retry-after': '5' })
		);
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:reissue-idempotency-conflict',
				title: 'Idempotency conflict',
				status: 409,
				detail:
					'The provided Idempotency-Key was previously used with different command parameters.',
				instance
			},
			securityHeaders()
		);
	}
	if (result.outcome === 'audit_conflict') {
		return problemResponse(
			{
				type: 'urn:signkit:problem:audit-head-conflict',
				title: 'Audit conflict',
				status: 409,
				detail: 'The envelope audit head was modified concurrently. Please retry.',
				instance
			},
			securityHeaders({ 'retry-after': '1' })
		);
	}
	return problemResponse(
		{
			type: 'urn:signkit:problem:reissue-integrity-error',
			title: 'Reissue integrity error',
			status: 503,
			detail: 'The reissue publication failed integrity checks.',
			instance
		},
		securityHeaders()
	);
}

function validationProblem(
	instance: string,
	detail: string,
	issues: readonly ZodIssue[]
): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:validation-error',
			title: 'Invalid reissue request',
			status: 400,
			detail,
			instance,
			errors: validationErrors(issues)
		},
		securityHeaders()
	);
}

function validationErrors(issues: readonly ZodIssue[]): ProblemValidationError[] {
	return issues.map((issue: ZodIssue): ProblemValidationError => ({
		path: issue.path.length === 0 ? '$' : issue.path.join('.'),
		message: issue.message
	}));
}

function idempotencyRequired(instance: string, issues: readonly ZodIssue[]): Response {
	return validationProblem(
		instance,
		'The Idempotency-Key header is required and must contain 1-200 visible ASCII characters.',
		issues
	);
}

function unsupportedMediaType(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: 'The request body must be application/json.',
			instance
		},
		securityHeaders({ accept: 'application/json' })
	);
}

function bodyTooLarge(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:payload-too-large',
			title: 'Payload too large',
			status: 413,
			detail: `The request body exceeds the maximum size of ${MAX_BODY_BYTES} bytes.`,
			instance
		},
		securityHeaders()
	);
}

function invalidJson(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:invalid-json',
			title: 'Invalid JSON',
			status: 400,
			detail: 'The request body could not be parsed as valid JSON.',
			instance
		},
		securityHeaders()
	);
}

function persistenceUnavailable(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:service-unavailable',
			title: 'Service unavailable',
			status: 503,
			detail: 'The persistence layer is unavailable.',
			instance
		},
		securityHeaders()
	);
}

function serviceUnavailable(instance: string): Response {
	return problemResponse(
		{
			type: 'urn:signkit:problem:service-unavailable',
			title: 'Service unavailable',
			status: 503,
			detail: 'The reissue service encountered an unexpected error.',
			instance
		},
		securityHeaders()
	);
}

function securityHeaders(extra: Record<string, string> = {}): Headers {
	const headers = new Headers({
		'x-content-type-options': 'nosniff',
		...extra
	});
	return headers;
}

function acceptsJson(request: Request): boolean {
	const contentType: string | null = request.headers.get('content-type');
	return contentType !== null && /^application\/json(?:\s*;|$)/i.test(contentType);
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
	const contentLength: string | null = request.headers.get('content-length');
	if (contentLength !== null) {
		const declaredBytes: number = Number(contentLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
			return { ok: false, reason: 'too_large' };
		}
	}
	let text: string;
	try {
		text = await request.text();
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		return { ok: false, reason: 'too_large' };
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
