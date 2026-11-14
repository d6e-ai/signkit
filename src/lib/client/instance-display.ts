import {
	INSTANCE_DISPLAY_EMAIL_MAX_LENGTH,
	INSTANCE_DISPLAY_NAME_MAX_LENGTH
} from '$lib/domain/instance-display';
import type { InvitationDisplay, MemberDisplay } from '$lib/ports/instance-display-store';
import type { InstanceInvitationMetadata } from '$lib/ports/instance-store';

const unavailable = (): MemberDisplay => ({ state: 'unavailable' });

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Copy only display fields; hidden payload/key/credential properties never enter UI state. */
export function readMemberDisplay(value: unknown, now = Date.now()): MemberDisplay {
	if (!record(value) || value.state !== 'available') return unavailable();
	if (
		!text(value.name, INSTANCE_DISPLAY_NAME_MAX_LENGTH) ||
		!text(value.email, INSTANCE_DISPLAY_EMAIL_MAX_LENGTH)
	)
		return unavailable();
	if (typeof value.observedAt !== 'string' || typeof value.expiresAt !== 'string') {
		return unavailable();
	}
	const observed = Date.parse(value.observedAt);
	const expires = Date.parse(value.expiresAt);
	if (
		!Number.isFinite(observed) ||
		!Number.isFinite(expires) ||
		expires <= observed ||
		expires <= now
	) {
		return unavailable();
	}
	return {
		state: 'available',
		name: value.name,
		email: value.email,
		observedAt: value.observedAt,
		expiresAt: value.expiresAt
	};
}

export function readMemberDisplays(
	value: unknown,
	userIds: readonly string[]
): Record<string, MemberDisplay> {
	const result: Record<string, MemberDisplay> = Object.create(null);
	for (const id of userIds.slice(0, 100)) {
		result[id] = readMemberDisplay(
			record(value) && Object.hasOwn(value, id) ? value[id] : undefined
		);
	}
	return result;
}

export function readInvitationDisplays(
	value: unknown,
	invitations: readonly InstanceInvitationMetadata[],
	now = Date.now()
): Record<string, InvitationDisplay> {
	const result: Record<string, InvitationDisplay> = Object.create(null);
	for (const invitation of invitations.slice(0, 100)) {
		const raw =
			record(value) && Object.hasOwn(value, invitation.id) ? value[invitation.id] : undefined;
		if (
			invitation.status === 'revoked' ||
			(invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= now)
		) {
			result[invitation.id] = { state: 'redacted' };
		} else if (invitation.status === 'accepted' && record(raw) && raw.state === 'accepted') {
			result[invitation.id] = { state: 'accepted', member: readMemberDisplay(raw.member, now) };
		} else if (
			invitation.status === 'pending' &&
			record(raw) &&
			raw.state === 'pending' &&
			text(raw.email, INSTANCE_DISPLAY_EMAIL_MAX_LENGTH)
		) {
			result[invitation.id] = { state: 'pending', email: raw.email };
		} else {
			result[invitation.id] = { state: 'unavailable' };
		}
	}
	return result;
}
