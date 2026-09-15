/**
 * Deploy-time bootstrap protection.
 *
 * Instance bootstrap is otherwise pure first-user-wins: whichever verified
 * identity reaches an empty instance first claims the sole `owner` slot (see
 * docs/architecture/deployment-and-risks.md § Primary risks). Configuring
 * `SIGNKIT_BOOTSTRAP_OWNER_EMAIL` narrows that race to one expected email
 * without introducing another long-lived cryptographic key: it is plain
 * deployment configuration, not a secret, and becomes irrelevant the moment
 * the instance is claimed since bootstrap never runs again. Leaving it unset
 * preserves the original behavior, which is also the local-development
 * escape hatch — nothing needs to be configured to develop locally.
 */

export type BootstrapOwnerGateResult = 'allowed' | 'owner_mismatch';

export interface BootstrapOwnerGateInput {
	readonly configuredEmail: string | undefined;
	readonly actorEmail: string;
}

export function resolveBootstrapOwnerGate({
	configuredEmail,
	actorEmail
}: BootstrapOwnerGateInput): BootstrapOwnerGateResult {
	const expected: string | undefined = normalizeEmail(configuredEmail);
	if (expected === undefined) return 'allowed';
	return normalizeEmail(actorEmail) === expected ? 'allowed' : 'owner_mismatch';
}

function normalizeEmail(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed: string = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.toLowerCase();
}
