import type { RequestHandler } from '@sveltejs/kit';
import type { ZodType } from 'zod';
import type {
	DeliveryStatusService,
	PublicEnvelopeDeliveryStatus
} from '$lib/application/delivery/delivery-status';
import {
	authorizeOrganizationRequest,
	type AuthorizedRequestActor
} from './organization-authorization';
import { signkitIdentifierSchema } from './identifier-schema';
import { problemResponse } from './problem';

const envelopeIdSchema: ZodType<string> = signkitIdentifierSchema;

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type DeliveryStatusServiceResolver = (
	context: ResolverContext
) => DeliveryStatusService | null | Promise<DeliveryStatusService | null>;

export function createDeliveryStatusHandler(
	resolveService: DeliveryStatusServiceResolver
): RequestHandler {
	return async ({ locals, params, platform, url }): Promise<Response> => {
		const authorized: AuthorizedRequestActor | Response = authorizeOrganizationRequest(
			locals,
			url.pathname
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

		let service: DeliveryStatusService | null;
		try {
			service = await resolveService({ platform });
		} catch (error: unknown) {
			logStatusError('delivery_status_resolution_failed', error);
			service = null;
		}
		if (service === null) return unavailable(url.pathname);

		try {
			const status: PublicEnvelopeDeliveryStatus | null = await service.find(
				authorized.organizationId,
				envelopeId.data
			);
			if (status === null) {
				return problemResponse({
					type: 'urn:signkit:problem:envelope-not-found',
					title: 'Envelope not found',
					status: 404,
					detail: 'No envelope was found in the authorized organization.',
					instance: url.pathname
				});
			}
			return Response.json({ delivery: status }, { headers: { 'cache-control': 'no-store' } });
		} catch (error: unknown) {
			logStatusError('delivery_status_failed', error);
			return unavailable(url.pathname);
		}
	};
}

function unavailable(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:delivery-status-unavailable',
		title: 'Delivery status unavailable',
		status: 503,
		detail: 'Delivery status could not be read.',
		instance
	});
}

function logStatusError(event: string, error: unknown): void {
	console.error(
		JSON.stringify({
			event,
			message: error instanceof Error ? error.name : 'UnknownError'
		})
	);
}
