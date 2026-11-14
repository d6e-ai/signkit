import type { InvitationDisplay, MemberDisplay } from '$lib/ports/instance-display-store';
import type { InstanceInvitationMetadata } from '$lib/ports/instance-store';

export const MEMBER_DISPLAY_RETENTION_DAYS: number = 90;
export const MEMBER_DISPLAY_RETENTION_MS: number =
	MEMBER_DISPLAY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT: number = 100;
export const INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT: number = 50;
export const INSTANCE_DISPLAY_NAME_MAX_LENGTH: number = 200;
export const INSTANCE_DISPLAY_EMAIL_MAX_LENGTH: number = 254;

const ISO_INSTANT_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function unavailableMemberDisplay(): MemberDisplay {
	return { state: 'unavailable' };
}

export function redactedInvitationDisplay(): InvitationDisplay {
	return { state: 'redacted' };
}

export function unavailableInvitationDisplay(): InvitationDisplay {
	return { state: 'unavailable' };
}

export function isIsoInstant(value: string): boolean {
	if (!ISO_INSTANT_PATTERN.test(value)) return false;
	return new Date(value).toISOString() === value;
}

export function memberDisplayExpiresAt(observedAt: string): string {
	if (!isIsoInstant(observedAt)) {
		throw new Error('Invalid member display observation time');
	}
	return new Date(Date.parse(observedAt) + MEMBER_DISPLAY_RETENTION_MS).toISOString();
}

export function boundInstanceDisplayCleanupLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, INSTANCE_DISPLAY_CLEANUP_BATCH_LIMIT);
}

export function boundInstanceDisplayResealLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, INSTANCE_DISPLAY_RESEAL_BATCH_LIMIT);
}

export function isUsableDisplayName(value: string): boolean {
	if (value.length < 1 || value.length > INSTANCE_DISPLAY_NAME_MAX_LENGTH) return false;
	for (const char of value) {
		const codePoint: number | undefined = char.codePointAt(0);
		if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
	}
	return true;
}

export function projectAvailableMemberDisplay(input: {
	name: string;
	email: string;
	observedAt: string;
	expiresAt: string;
	now: string;
}): MemberDisplay {
	if (
		!isUsableDisplayName(input.name) ||
		!isIsoInstant(input.observedAt) ||
		!isIsoInstant(input.expiresAt)
	) {
		return unavailableMemberDisplay();
	}
	if (input.expiresAt !== memberDisplayExpiresAt(input.observedAt)) {
		return unavailableMemberDisplay();
	}
	if (input.expiresAt <= input.now || input.observedAt > input.now) {
		return unavailableMemberDisplay();
	}
	if (input.email.length < 3 || input.email.length > INSTANCE_DISPLAY_EMAIL_MAX_LENGTH) {
		return unavailableMemberDisplay();
	}
	return {
		state: 'available',
		name: input.name,
		email: input.email,
		observedAt: input.observedAt,
		expiresAt: input.expiresAt
	};
}

export function invitationDisplayState(
	invitation: Pick<InstanceInvitationMetadata, 'status' | 'expiresAt'>,
	now: string
): 'pending' | 'accepted' | 'redacted' {
	if (invitation.status === 'accepted') return 'accepted';
	if (invitation.status === 'revoked') return 'redacted';
	if (invitation.expiresAt <= now) return 'redacted';
	return 'pending';
}

export function allowlistedMemberDisplay(value: MemberDisplay): MemberDisplay {
	if (value.state === 'available') {
		return {
			state: 'available',
			name: value.name,
			email: value.email,
			observedAt: value.observedAt,
			expiresAt: value.expiresAt
		};
	}
	return unavailableMemberDisplay();
}

export function allowlistedInvitationDisplay(value: InvitationDisplay): InvitationDisplay {
	if (value.state === 'pending') {
		return { state: 'pending', email: value.email };
	}
	if (value.state === 'accepted') {
		return { state: 'accepted', member: allowlistedMemberDisplay(value.member) };
	}
	if (value.state === 'redacted') return redactedInvitationDisplay();
	return unavailableInvitationDisplay();
}
