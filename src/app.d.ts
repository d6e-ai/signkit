/// <reference types="@cloudflare/workers-types" />

import type { ApiKeyPrincipal } from '$lib/ports/api-key-authentication-store';
import type { VerifiedPrincipal } from '$lib/server/d6e-auth';
import type { InstanceMemberRole, InstanceMemberStatus } from '$lib/ports/instance-store';

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
	| { state: 'integrity_error' }
	| { state: 'unavailable' };

/**
 * The caller's local instance membership, resolved from the durable instance
 * store for every verified session. d6e-auth proves identity only
 * (subject/name/email); this row is the sole operator authority.
 */
export interface InstanceMembership {
	userId: string;
	role: InstanceMemberRole;
	status: InstanceMemberStatus;
}

/**
 * Verified session identity resolved against local instance membership:
 *
 * - `anonymous`: no session cookie.
 * - `active`: verified identity with an active local instance member row.
 * - `no_membership`: verified identity with no local member row. Only
 *   bootstrap and self-profile surfaces authorize this state.
 * - `suspended`: verified identity whose local member row is suspended.
 * - `unavailable`: identity or membership could not be verified.
 */
export type IdentityState = 'anonymous' | 'active' | 'no_membership' | 'suspended' | 'unavailable';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			principal: VerifiedPrincipal | null;
			instanceMembership: InstanceMembership | null;
			bootstrapped: boolean;
			identityState: IdentityState;
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
				SIGNKIT_PUBLIC_ORIGIN?: string;
				SIGNKIT_EMAIL_FROM?: string;
				SIGNKIT_EMAIL_FROM_NAME?: string;
				SIGNKIT_MAIL_PROVIDER?: string;
				SIGNKIT_SMTP_HOST?: string;
				SIGNKIT_SMTP_PORT?: string;
				SIGNKIT_SMTP_SECURE?: string;
				SIGNKIT_SMTP_USERNAME?: string;
				SIGNKIT_SMTP_PASSWORD?: string;
				SIGNKIT_WEBHOOK_ALLOWED_HOSTS?: string;
				SESSION_ENCRYPTION_KEY?: string;
				SESSION_ENCRYPTION_KEY_PREVIOUS?: string;
				SIGNKIT_BOOTSTRAP_OWNER_EMAIL?: string;
				SIGNKIT_ALLOW_UNSAFE_FIRST_USER_BOOTSTRAP?: string;
				PDF_SEAL_PROFILE?: string;
				PDF_SEAL_PROVIDER_URL?: string;
				PDF_SEAL_PROVIDER_TOKEN?: string;
				PDF_SEAL_VALIDATOR_URL?: string;
				PDF_SEAL_VALIDATOR_TOKEN?: string;
				PDF_SEAL_SIGNER_CERTIFICATE_SHA256?: string;
				PDF_SEAL_POLICY_ID?: string;
				PDF_SEAL_VALIDATION_POLICY_ID?: string;
				PDF_SEAL_TSA_POLICY_ID?: string;
				PDF_SEAL_TSA_TRUST_BUNDLE_SHA256?: string;
			};
			context?: { waitUntil(promise: Promise<unknown>): void };
			caches?: CacheStorage;
		}
	}
}

export {};

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
	const workerUrl: string;
	export default workerUrl;
}
