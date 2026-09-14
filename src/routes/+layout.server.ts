import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { resolveInstanceApplication } from '$lib/application/instance/instance-runtime';
import type { InstanceApplicationPort } from '$lib/application/instance/instance-service';
import type { InstanceCallerContext } from '$lib/ports/instance-store';
import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';
import { isSettingsSurfacePath } from '$lib/navigation/settings-surface';
import { isSetupSurfacePath } from '$lib/navigation/setup-surface';
import { isSignedOutSurfacePath } from '$lib/navigation/signed-out-surface';
import { localizeHref } from '$lib/paraglide/runtime';

/**
 * Central page-access gate for every non-recipient browser page.
 *
 * `locals.principal` is null for both `anonymous` and `unavailable` identity
 * states (hooks.server.ts only ever assigns it once verification *and*
 * organization lookup both succeed), so it is the single narrowing check for
 * TypeScript, but the two states are not equivalent: `anonymous` redirects to
 * sign-in, while `unavailable` means a session exists but identity could not
 * be verified -- redirecting that case into `/auth/login` would either loop
 * back through the same failing d6e-auth call or silently treat a verification
 * failure as an invitation to reauthenticate, so it fails closed with a 503
 * instead. `no_active_organization` carries a non-null principal like
 * `authorized` does, so it is unaffected by either branch and remains eligible
 * for instance bootstrap and membership below -- this slice's authority is the
 * local `instance_member` model, never d6e organization membership.
 *
 * The recipient signing surface is exempt because its visitors are never
 * SignKit account holders -- they authenticate with a capability link, not a
 * d6e-auth session. The signed-out surface is exempt for the opposite reason:
 * it is the page `POST /auth/logout` redirects to, and it exists specifically
 * so a just-logged-out caller lands on a public page with a Sign In action
 * instead of being bounced straight back through this same gate into another
 * OAuth round trip.
 */
export const load: LayoutServerLoad = async ({ locals, platform, url }) => {
	// Omitted rather than `{ email: null }`: the recipient surface has its own
	// page data shape, and a field returned unconditionally from every branch
	// here would become non-optional in every descendant route's merged
	// `PageData` -- including recipient pages that have nothing to do with an
	// authenticated email at all.
	if (isRecipientSurfacePath(url.pathname)) return {};
	if (isSignedOutSurfacePath(url.pathname)) return {};

	if (locals.principal === null) {
		if (locals.identityState === 'unavailable') {
			error(503, 'Identity could not be verified.');
		}
		const returnTo: string = `${url.pathname}${url.search}`;
		redirect(302, localizeHref(`/auth/login?return=${encodeURIComponent(returnTo)}`));
	}

	const email: string = locals.principal.email;

	let application: InstanceApplicationPort | null;
	try {
		application = await resolveInstanceApplication({ platform });
	} catch {
		application = null;
	}
	// Unlike the API layer -- which independently re-derives its own
	// authorization on every request and can safely let a page fail on its next
	// data fetch -- this gate is the only thing standing between an
	// unresolvable durable store and rendering a normal page shell for a caller
	// whose membership can no longer be proven. Proceeding here would be a real
	// gap, not merely a UX one, so an unresolvable store fails the whole
	// navigation closed with a 503 rather than falling through.
	if (application === null) {
		error(503, 'Instance persistence unavailable.');
	}

	let context: InstanceCallerContext;
	try {
		context = await application.getCurrentMember({ id: locals.principal.subject });
	} catch {
		error(503, 'Instance membership could not be resolved.');
	}

	if (!context.bootstrapped) {
		if (!isSetupSurfacePath(url.pathname)) redirect(302, localizeHref('/setup'));
		return { email };
	}
	if (isSetupSurfacePath(url.pathname)) redirect(302, localizeHref('/'));

	const isActiveMember: boolean = context.member?.status === 'active';
	if (!isActiveMember && !isSettingsSurfacePath(url.pathname)) {
		redirect(302, localizeHref('/settings'));
	}

	return { email };
};
