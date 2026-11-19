import { sha256TextHex } from './audit';

export interface SigningInstructionRequest {
	version: 1;
	locale: 'en' | 'ja';
	sentEventHash: string;
}

export interface SigningInstructionPrompt extends SigningInstructionRequest {
	statement: string;
}

export interface SigningInstruction extends SigningInstructionRequest {
	textSha256: string;
	fieldGeneration: number;
}

// Version 1 is immutable in each locale. Introduce a new version to change the statement.
const STATEMENTS = {
	en: 'I agree to sign this version of the documents electronically and instruct SignKit to apply my electronic signature to them.',
	ja: 'この版の文書に電子署名することに同意し、SignKitに私の電子署名を付すよう指示します。'
} as const;

const SHA256 = /^[a-f0-9]{64}$/;

export function signingInstructionPrompt(
	sentEventHash: string,
	locale: SigningInstructionRequest['locale']
): SigningInstructionPrompt {
	return { version: 1, locale, sentEventHash, statement: STATEMENTS[locale] };
}

export function instructionRequest(
	instruction: SigningInstructionRequest
): SigningInstructionRequest {
	return {
		version: instruction.version,
		locale: instruction.locale,
		sentEventHash: instruction.sentEventHash
	};
}

export async function createSigningInstruction(
	request: SigningInstructionRequest,
	fieldGeneration: number
): Promise<SigningInstruction> {
	return {
		...instructionRequest(request),
		textSha256: await sha256TextHex(STATEMENTS[request.locale]),
		fieldGeneration
	};
}

/** `undefined` is a historical payload; `null` denotes corrupt evidence. */
export async function readSigningInstruction(
	payload: unknown
): Promise<SigningInstruction | undefined | null> {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	if (!('signingInstruction' in payload)) return undefined;
	const value = payload.signingInstruction;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const { version, locale, sentEventHash, textSha256, fieldGeneration } = value as Record<
		string,
		unknown
	>;
	if (
		Object.keys(value).length !== 5 ||
		version !== 1 ||
		(locale !== 'en' && locale !== 'ja') ||
		typeof sentEventHash !== 'string' ||
		!SHA256.test(sentEventHash) ||
		typeof fieldGeneration !== 'number' ||
		!Number.isSafeInteger(fieldGeneration) ||
		fieldGeneration < 0
	)
		return null;
	const instruction = await createSigningInstruction(
		{ version, locale, sentEventHash },
		fieldGeneration
	);
	return instruction.textSha256 === textSha256 ? instruction : null;
}

export async function readSigningInstructionJson(
	json: string
): Promise<SigningInstruction | undefined | null> {
	try {
		return await readSigningInstruction(JSON.parse(json) as unknown);
	} catch {
		return null;
	}
}
