/**
 * Marker appended to the end of the canonical `envelope.sent` audit payload for
 * every newly published send. Historical payloads omit it and keep their exact
 * original bytes.
 */
export const SIGNING_INSTRUCTION_VERSION = 1 as const;

/**
 * Reads the signing-instruction marker from a parsed `envelope.sent` payload.
 * Returns `undefined` when absent (historical send), the version when it is a
 * recognized value, and `null` when present but unrecognized.
 */
export function sentSigningInstructionVersion(
	payload: Record<string, unknown>
): typeof SIGNING_INSTRUCTION_VERSION | undefined | null {
	if (!Object.hasOwn(payload, 'signingInstructionVersion')) return undefined;
	return payload.signingInstructionVersion === SIGNING_INSTRUCTION_VERSION
		? SIGNING_INSTRUCTION_VERSION
		: null;
}
