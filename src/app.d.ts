/// <reference types="@cloudflare/workers-types" />

import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { OrganizationMembership, VerifiedPrincipal } from '$lib/server/d6e-auth';

/**
 * Outcome of resolving a `signkit_` bearer token for this request.
 *
 * `absent` is the only state in which a cookie session may be considered. Every
 * other state means an `Authorization` header was presented on an API-key
 * surface, which selects bearer mode exclusively for the whole request: there is
 * no fallback to a cookie, so a malformed or unauthorized bearer fails closed
 * instead of quietly inheriting whatever browser session accompanied it.
 */
export type ApiKeyAuthenticationState =
	| { state: 'absent' }
	| { state: 'authenticated'; principal: ApiKeyPrincipal }
	/**
	 * A well-formed API key was presented on a management surface that never
	 * accepts one. Distinct from `invalid_token` because nothing was looked up:
	 * the key is refused on the strength of where it was presented, and the
	 * cookie is suppressed so it cannot authorize the request instead.
	 */
	| { state: 'rejected_surface' }
	| { state: 'invalid_token' }
	| { state: 'rate_limited' }
	| { state: 'organization_selector_invalid' }
	| { state: 'organization_grant_required' }
	| { state: 'integrity_error' }
	| { state: 'unavailable' };

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			principal: VerifiedPrincipal | null;
			memberships: OrganizationMembership[];
			organizationId: string | null;
			identityState: 'anonymous' | 'authorized' | 'no_active_organization' | 'unavailable';
			/**
			 * Required rather than optional on purpose: every authorization helper
			 * reads it to decide whether bearer mode is in force, and a field that
			 * could be forgotten is a field that would silently re-enable cookie
			 * fallback for an API key request.
			 */
			apiKeyAuthentication: ApiKeyAuthenticationState;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env?: {
				DB?: D1Database;
				EMAIL?: SendEmail;
				OBJECTS?: R2Bucket;
				DELIVERY_ENCRYPTION_KEY?: string;
				DELIVERY_ENCRYPTION_KEY_PREVIOUS?: string;
				DELIVERY_WORKER_SECRET?: string;
				SIGNKIT_BOOTSTRAP_SECRET?: string;
				SIGNKIT_PUBLIC_ORIGIN?: string;
				SIGNKIT_EMAIL_FROM?: string;
				SIGNKIT_EMAIL_FROM_NAME?: string;
				SIGNKIT_MAIL_PROVIDER?: string;
				SESSION_ENCRYPTION_KEY?: string;
				SESSION_ENCRYPTION_KEY_PREVIOUS?: string;
			};
			context?: { waitUntil(promise: Promise<unknown>): void };
			caches?: CacheStorage;
		}
	}
}

export {};
