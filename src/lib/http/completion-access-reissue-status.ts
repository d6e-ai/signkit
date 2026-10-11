import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import type { CompletionAccessReissueApplicationPort } from '$lib/application/completion-delivery/completion-access-reissue-service';
import type { CurrentCompletionDeliveryRow } from '$lib/ports/completion-access-reissue-row';
import { authorizeScopedInstanceRequest, type AuthorizedApiActor } from './api-key-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;

interface ResolverContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

/** The handler needs only `listCurrentDeliveries`; a structural port keeps stubs honest. */
export type CompletionAccessReissueStatusPort = Pick<
	CompletionAccessReissueApplicationPort,
	'listCurrentDeliveries'
>;

export type CompletionAccessReissueStatusServiceResolver = (
	context: ResolverContext
) => CompletionAccessReissueStatusPort | null | Promise<CompletionAccessReissueStatusPort | null>;

/**
 * Instance-authorized, explicit-allowlist read of each recipient's current
 * completion delivery generation: delivery and recipient IDs, generation,
 * status, attempts, expiry/revocation timestamps, the sanitized failure
 * error code, and whether that generation is eligible for reissue. Never a
 * raw or sealed token, a claim lease, or any other grant material.
 */
export function createCompletionAccessReissueStatusHandler(
	resolveService: CompletionAccessReissueStatusServiceResolver
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedApiActor | Response = authorizeScopedInstanceRequest(
			locals,
			url.pathname,
			'envelopes:read'
		);
		if (authorized instanceof Response) return authorized;

		const envelopeId = envelopeIdSchema.safeParse(params.envelopeId);
		if (!envelopeId.success) {
			return problemResponse({
				type: 'urn:signkit:problem:validation-error',
				title: 'Validation failed',
				status: 400,
				detail: 'The envelope ID must be a UUID.',
				instance: url.pathname
			});
		}

		let service: CompletionAccessReissueStatusPort | null;
		try {
			service = await resolveService({ locals, platform });
		} catch (error: unknown) {
			logError('completion_access_reissue_status_resolution_failed', error);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const deliveries: readonly CurrentCompletionDeliveryRow[] =
				await service.listCurrentDeliveries(envelopeId.data);
			return Response.json(
				{
					completionDeliveries: deliveries.map(
						(row: CurrentCompletionDeliveryRow): CurrentCompletionDeliveryRow => ({
							deliveryId: row.deliveryId,
							recipientId: row.recipientId,
							recipientRole: row.recipientRole,
							generation: row.generation,
							status: row.status,
							attempts: row.attempts,
							accessExpiresAt: row.accessExpiresAt,
							accessRevokedAt: row.accessRevokedAt,
							deliveredAt: row.deliveredAt,
							failedAt: row.failedAt,
							errorCode: row.errorCode,
							eligibleForReissue: row.eligibleForReissue
						})
					)
				},
				{ headers: { 'cache-control': 'no-store' } }
			);
		} catch (error: unknown) {
			logError('completion_access_reissue_status_failed', error);
			return unavailable(url.pathname);
		}
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:completion-access-reissue-status-unavailable',
		title: 'Completion access reissue status unavailable',
		status: 503,
		detail: 'Completion delivery status could not be read.',
		instance
	});
}

function logError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({ event, message: error instanceof Error ? error.name : 'UnknownError' })
	);
}
