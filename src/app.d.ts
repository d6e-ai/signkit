/// <reference types="@cloudflare/workers-types" />

import type { OrganizationMembership, VerifiedPrincipal } from '$lib/server/d6e-auth';

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
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env?: {
				DB?: D1Database;
				EMAIL?: SendEmail;
				OBJECTS?: R2Bucket;
				DELIVERY_ENCRYPTION_KEY?: string;
				DELIVERY_WORKER_SECRET?: string;
				SIGNKIT_BOOTSTRAP_SECRET?: string;
				SIGNKIT_PUBLIC_ORIGIN?: string;
				SIGNKIT_EMAIL_FROM?: string;
				SIGNKIT_EMAIL_FROM_NAME?: string;
			};
			context?: { waitUntil(promise: Promise<unknown>): void };
			caches?: CacheStorage;
		}
	}
}

export {};
