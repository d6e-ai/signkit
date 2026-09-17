import type { InstanceMemberIdentitySnapshot } from '$lib/ports/instance-store';

const MAX_DISPLAY_NAME_LENGTH: number = 200;
const MAX_EMAIL_LENGTH: number = 320;

/**
 * Converts verified d6e-auth claims into bounded display-only member labels.
 * Invalid or unexpectedly large claims are discarded rather than blocking an
 * authorization operation; the external subject remains the sole identity
 * key and these values never participate in access decisions.
 */
export function memberIdentitySnapshot(
	displayName: string | undefined,
	email: string | undefined
): InstanceMemberIdentitySnapshot {
	return {
		displayName: boundedDisplayName(displayName),
		email: boundedEmail(email)
	};
}

function boundedDisplayName(value: string | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed: string = value.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_DISPLAY_NAME_LENGTH ||
		hasForbiddenCharacter(trimmed, false)
	) {
		return null;
	}
	return trimmed;
}

function boundedEmail(value: string | undefined): string | null {
	if (typeof value !== 'string') return null;
	const normalized: string = value.trim().toLowerCase();
	const at: number = normalized.indexOf('@');
	if (
		normalized.length < 3 ||
		normalized.length > MAX_EMAIL_LENGTH ||
		at < 1 ||
		at === normalized.length - 1 ||
		hasForbiddenCharacter(normalized, true)
	) {
		return null;
	}
	return normalized;
}

function hasForbiddenCharacter(value: string, rejectSpace: boolean): boolean {
	const upperBound: number = rejectSpace ? 0x20 : 0x1f;
	return Array.from(value).some((character: string): boolean => {
		const codePoint: number = character.codePointAt(0) ?? 0;
		return codePoint <= upperBound || codePoint === 0x7f;
	});
}
