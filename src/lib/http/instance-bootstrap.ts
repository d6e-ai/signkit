import { env } from '$env/dynamic/private';
import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue, type ZodType } from 'zod';
import {
	InvalidInstanceBootstrapRequestError,
	type BootstrapInstanceResult,
	type InstanceApplicationPort
} from '$lib/application/instance/instance-service';
import { resolveBootstrapOwnerGate } from '$lib/security/bootstrap-owner-gate';
import {
	acceptsJson,
	readJsonBody,
	validationErrors,
	type JsonBodyResult
} from './bounded-json-body';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse, type ProblemValidationError } from './problem';

const MAX_BOOTSTRAP_BODY_BYTES: number = 1024;

const idempotencyKeySchema: ZodType<string> = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain visible ASCII characters only');

const bootstrapBodySchema: ZodType<Record<string, never>> = z.object({}).strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceApplicationResolver = (
	context: ResolverContext
) => InstanceApplicationPort | null | Promise<InstanceApplicationPort | null>;

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
		errors: validationErrors(issues, true)
	});
}

function unsupportedMediaType(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:unsupported-media-type',
		title: 'Unsupported media type',
		status: 415,
		detail: 'Bootstrap requests require an application/json request body.',
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
		title: 'Instance persistence unavailable',
		status: 503,
		detail: 'The durable instance store is not configured for this deployment.',
		instance
	});
}

function serviceUnavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'Instance service unavailable',
		status: 503,
		detail: 'The bootstrap operation could not be completed.',
		instance
	});
}

function integrityError(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:instance-integrity-error',
		title: 'Instance integrity check failed',
		status: 503,
		detail: 'The bootstrap command could not prove consistent instance state.',
		instance
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown error';
}

function ownerMismatch(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:bootstrap-owner-mismatch',
		title: 'Bootstrap restricted to the configured owner',
		status: 403,
		detail:
			'This deployment restricts instance bootstrap to a specific verified email. The instance remains unclaimed.',
		instance
	});
}

/**
 * Reads the optional deploy-time owner-email allowlist. Checks `platform.env`
 * first so Cloudflare Workers vars/secrets take precedence, matching every
 * other Worker-vs-Node config resolver in this codebase (e.g. delivery-drain.ts).
 * Never returns the configured value itself to a caller other than the
 * comparison below — it must not appear in logs or responses.
 */
export function resolveBootstrapOwnerEmail(platform?: Readonly<App.Platform>): string | undefined {
	const configured: string | undefined =
		platform?.env?.SIGNKIT_BOOTSTRAP_OWNER_EMAIL ?? env.SIGNKIT_BOOTSTRAP_OWNER_EMAIL;
	const trimmed: string | undefined = configured?.trim();
	return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function createInstanceBootstrapHandler(
	resolveApplication: InstanceApplicationResolver,
	resolveOwnerEmail: (
		platform?: Readonly<App.Platform>
	) => string | undefined = resolveBootstrapOwnerEmail
): RequestHandler {
	return async ({ locals, platform, request, url }): Promise<Response> => {
		// Bootstrap is cookie-session-only: a `signkit_` API key is already
		// rejected upstream in hooks.server.ts (instance management surfaces never
		// resolve one), so a non-absent apiKeyAuthentication state here can only be
		// that rejection, and authorizeIdentityRequest below answers it with 403.
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		// Idempotency-Key
		const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
		if (!idempotencyKey.success) {
			return idempotencyKeyRequired(url.pathname, idempotencyKey.error.issues);
		}

		// Content-Type & bounded empty JSON object body
		if (!acceptsJson(request)) {
			return unsupportedMediaType(url.pathname);
		}

		const body: JsonBodyResult = await readJsonBody(request, MAX_BOOTSTRAP_BODY_BYTES);
		if (!body.ok) {
			return body.reason === 'too_large'
				? bodyTooLarge(url.pathname, MAX_BOOTSTRAP_BODY_BYTES)
				: invalidJson(url.pathname);
		}

		const parsed = bootstrapBodySchema.safeParse(body.value);
		if (!parsed.success) {
			return validationFailed(
				url.pathname,
				'The bootstrap request body must be an empty JSON object.',
				validationErrors(parsed.error.issues, true)
			);
		}

		// Consistent with instance-invitations.ts acceptance: claiming instance
		// ownership on the strength of a session is not a provider-verified
		// inbox guarantee, so a missing or false `email_verified` claim fails
		// closed here too.
		if (authorized.emailVerified !== true) {
			return problemResponse({
				type: 'urn:signkit:problem:email-verification-required',
				title: 'Email verification required',
				status: 403,
				detail: 'Claiming instance ownership requires a provider-verified email claim.',
				instance: url.pathname
			});
		}

		// Deploy-time bootstrap protection: checked before the store is ever
		// consulted, so a mismatched caller never consumes the single
		// empty-instance window that the real owner still needs.
		const ownerGate = resolveBootstrapOwnerGate({
			configuredEmail: resolveOwnerEmail(platform),
			actorEmail: authorized.email
		});
		if (ownerGate === 'owner_mismatch') {
			return ownerMismatch(url.pathname);
		}

		let application: InstanceApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_bootstrap_resolution_failed',
					message: errorMessage(error)
				})
			);
			application = null;
		}
		if (application === null) {
			return persistenceUnavailable(url.pathname);
		}

		try {
			const result: BootstrapInstanceResult = await application.bootstrapInstance(
				{ id: authorized.id },
				{ idempotencyKey: idempotencyKey.data }
			);
			return bootstrapResponse(result, url.pathname);
		} catch (error: unknown) {
			if (error instanceof InvalidInstanceBootstrapRequestError) {
				return validationFailed(url.pathname, error.message, [
					{ path: '$', message: error.message }
				]);
			}
			console.error(
				JSON.stringify({ event: 'instance_bootstrap_failed', message: errorMessage(error) })
			);
			return serviceUnavailable(url.pathname);
		}
	};
}

function bootstrapResponse(result: BootstrapInstanceResult, instance: string): Response {
	if (result.outcome === 'bootstrapped') {
		return new Response(JSON.stringify({ member: result.member, bootstrapped: true }), {
			status: 201,
			headers: { 'cache-control': 'no-store', 'content-type': 'application/json' }
		});
	}
	if (result.outcome === 'already_bootstrapped' && result.replayed) {
		return new Response(JSON.stringify({ member: result.member, bootstrapped: true }), {
			status: 200,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/json',
				'idempotency-replayed': 'true'
			}
		});
	}
	if (result.outcome === 'idempotency_conflict') {
		return problemResponse({
			type: 'urn:signkit:problem:instance-bootstrap-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: 'The Idempotency-Key was already used for a different bootstrap request.',
			instance
		});
	}
	if (result.outcome === 'already_bootstrapped' && !result.replayed) {
		return problemResponse({
			type: 'urn:signkit:problem:instance-already-bootstrapped',
			title: 'Instance already bootstrapped',
			status: 409,
			detail: 'The instance has already been claimed by an owner.',
			instance
		});
	}
	return integrityError(instance);
}
