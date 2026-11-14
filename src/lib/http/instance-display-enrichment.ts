import type { InstanceDisplayApplicationPort } from '$lib/application/instance-display/instance-display-service';
import {
	unavailableInvitationDisplay,
	unavailableMemberDisplay
} from '$lib/domain/instance-display';
import type { InvitationDisplay, MemberDisplay } from '$lib/ports/instance-display-store';
import type { InstanceInvitationMetadata, InstanceMemberMetadata } from '$lib/ports/instance-store';

export const INSTANCE_DISPLAY_ENRICHMENT_FAILED_CODE: string = 'instance_display_enrichment_failed';

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type InstanceDisplayApplicationResolver = (
	context: ResolverContext
) => InstanceDisplayApplicationPort | null | Promise<InstanceDisplayApplicationPort | null>;

export async function enrichMemberDisplays(
	resolveDisplay: InstanceDisplayApplicationResolver | null | undefined,
	platform: Readonly<App.Platform> | undefined,
	actorId: string,
	members: readonly InstanceMemberMetadata[]
): Promise<Record<string, MemberDisplay> | undefined> {
	if (resolveDisplay === null || resolveDisplay === undefined) return undefined;
	const fallback: Record<string, MemberDisplay> = {};
	for (const member of members) fallback[member.userId] = unavailableMemberDisplay();
	try {
		const application: InstanceDisplayApplicationPort | null = await resolveDisplay({ platform });
		if (application === null) return fallback;
		return await application.memberDisplays({ type: 'user', id: actorId }, members, nowIso());
	} catch {
		logEnrichmentFailed();
		return fallback;
	}
}

export async function enrichInvitationDisplays(
	resolveDisplay: InstanceDisplayApplicationResolver | null | undefined,
	platform: Readonly<App.Platform> | undefined,
	actorId: string,
	invitations: readonly InstanceInvitationMetadata[]
): Promise<Record<string, InvitationDisplay> | undefined> {
	if (resolveDisplay === null || resolveDisplay === undefined) return undefined;
	const fallback: Record<string, InvitationDisplay> = {};
	for (const invitation of invitations) fallback[invitation.id] = unavailableInvitationDisplay();
	try {
		const application: InstanceDisplayApplicationPort | null = await resolveDisplay({ platform });
		if (application === null) return fallback;
		return await application.invitationDisplays(
			{ type: 'user', id: actorId },
			invitations,
			nowIso()
		);
	} catch {
		logEnrichmentFailed();
		return fallback;
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function logEnrichmentFailed(): void {
	console.error(
		JSON.stringify({
			event: INSTANCE_DISPLAY_ENRICHMENT_FAILED_CODE,
			code: INSTANCE_DISPLAY_ENRICHMENT_FAILED_CODE
		})
	);
}
