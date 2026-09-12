import type { RequestHandler } from '@sveltejs/kit';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceCallerContext } from '$lib/ports/instance-store';
import { authorizeIdentityRequest, type AuthorizedIdentityActor } from './identity-authorization';
import { problemResponse } from './problem';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceApplicationResolver = (
	context: ResolverContext
) => InstanceApplicationPort | null | Promise<InstanceApplicationPort | null>;

export function createInstanceMemberMeHandler(
	resolveApplication: InstanceApplicationResolver
): RequestHandler {
	return async ({ locals, platform, url }): Promise<Response> => {
		const authorized: AuthorizedIdentityActor | Response = authorizeIdentityRequest(
			locals,
			url.pathname
		);
		if (authorized instanceof Response) return authorized;

		let application: InstanceApplicationPort | null;
		try {
			application = await resolveApplication({ platform });
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_member_me_resolution_failed',
					message: error instanceof Error ? error.message : 'Unknown error'
				})
			);
			application = null;
		}
		if (application === null) {
			return problemResponse({
				type: 'urn:signkit:problem:persistence-unavailable',
				title: 'Instance persistence unavailable',
				status: 503,
				detail: 'The durable instance store is not configured for this deployment.',
				instance: url.pathname
			});
		}

		try {
			const context: InstanceCallerContext = await application.getCurrentMember({
				id: authorized.id
			});
			return new Response(JSON.stringify(context), {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			});
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'instance_member_me_failed',
					message: error instanceof Error ? error.message : 'Unknown error'
				})
			);
			return problemResponse({
				type: 'urn:signkit:problem:service-unavailable',
				title: 'Instance service unavailable',
				status: 503,
				detail: 'The caller membership could not be retrieved.',
				instance: url.pathname
			});
		}
	};
}
