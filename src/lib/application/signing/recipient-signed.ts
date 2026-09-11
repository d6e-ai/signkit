import type { FieldType } from '$lib/domain/envelope';
import type {
	SignableFieldDeclaration,
	SignFingerprintValue,
	SignLookupKey,
	SignPreparation,
	SignRoutingSnapshot,
	SignedFieldValue,
	PublishRecipientSignedCommand,
	PublishRecipientSignedResult,
	PublishedRecipientSigned,
	RecipientSignStore
} from '$lib/ports/recipient-sign-store';
import { canonicalRecipientSignFingerprint } from '$lib/ports/recipient-sign-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';

const MAX_AUDIT_ATTEMPTS: number = 3;
const NEXT_ROUTING_CAPABILITY_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;
const MAX_FIELD_COUNT: number = 50;
const MAX_SIGNATURE_LENGTH: number = 200;
const MAX_INITIALS_LENGTH: number = 20;
const MAX_TEXT_LENGTH: number = 4000;
const MAX_GENERATION: number = 2_147_483_647;
const DATE_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUL: string = String.fromCharCode(0);

export interface SignFieldValueInput {
	fieldId: string;
	value: string | boolean;
}

export interface RecipientSignedInput {
	token: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	expectedFieldGeneration: number;
	idempotencyKey: string;
	values: readonly SignFieldValueInput[];
}

export type RecipientSignedResult =
	| { outcome: 'published' | 'replayed'; result: PublishedRecipientSigned }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'invalid_field' }
	| { outcome: 'incomplete_field_set' }
	| { outcome: 'missing_required_value' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface RecipientSignedApplicationPort {
	sign(input: RecipientSignedInput): Promise<RecipientSignedResult>;
}

export class InvalidSignInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSignInputError';
	}
}

export class RecipientSignedApplication implements RecipientSignedApplicationPort {
	constructor(
		private readonly store: RecipientSignStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async sign(input: RecipientSignedInput): Promise<RecipientSignedResult> {
		assertSignInput(input.expectedFieldGeneration, input.values);

		const capabilityHash: string = await hashRecipientCapability(input.token);
		const lookup: SignLookupKey = {
			capabilityHash,
			expectedEnvelopeId: input.expectedEnvelopeId,
			expectedRecipientId: input.expectedRecipientId,
			idempotencyKey: input.idempotencyKey,
			expectedFieldGeneration: input.expectedFieldGeneration
		};

		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const signedAt: string = this.now().toISOString();
			const preparation: SignPreparation = await this.store.prepareSign(lookup, signedAt);
			if (preparation.outcome === 'existing') {
				return await replayExisting(preparation, input, capabilityHash);
			}
			if (preparation.outcome !== 'ready') return preparation;
			if (preparation.fieldGeneration !== input.expectedFieldGeneration) {
				return { outcome: 'field_generation_conflict' };
			}

			const matched: MatchedFieldValues | MatchFailure = await matchFieldValues(
				preparation.fields,
				input.values
			);
			if (matched.outcome !== 'ok') return matched;
			const fieldValues: readonly SignedFieldValue[] = matched.fieldValues;
			const requestFingerprint: string = await fingerprintFromFieldValues(
				input,
				capabilityHash,
				fieldValues
			);

			const auditEventId: string = await deterministicUuid(
				[
					'signkit-recipient-signed-event-v1',
					preparation.organizationId,
					preparation.envelopeId,
					preparation.recipientId,
					input.idempotencyKey
				].join(NUL)
			);
			const auditPayloadJson: string = JSON.stringify({
				recipientId: preparation.recipientId,
				role: 'signer',
				routingOrder: preparation.routingOrder,
				sentCommitSha: preparation.sentCommitSha,
				fields: fieldValues.map((field: SignedFieldValue) => ({
					id: field.fieldId,
					fieldType: field.fieldType,
					valueSha256: field.valueSha256
				})),
				signedAt
			});
			const auditEventHash: string = await sha256(
				JSON.stringify({
					actorId: preparation.recipientId,
					envelopeId: preparation.envelopeId,
					eventType: 'recipient.signed',
					occurredAt: signedAt,
					organizationId: preparation.organizationId,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				})
			);

			const routing: SignRoutingSnapshot = preparation.routing;
			const shouldComplete: boolean = routing.remainingActionableOutstanding === 0;
			const shouldRelease: boolean =
				!shouldComplete &&
				routing.currentGroupOutstanding === 0 &&
				routing.nextRoutingOrder !== null;

			let completedAuditEventId: string | null = null;
			let completedAuditEventHash: string | null = null;
			let completedAuditPayloadJson: string | null = null;
			let nextRoutingOrder: number | null = null;
			let nextCapabilityExpiresAt: string | null = null;
			let releasedDeliveryCount: number = 0;

			if (shouldComplete) {
				completedAuditEventId = await deterministicUuid(
					[
						'signkit-envelope-completed-event-v1',
						preparation.organizationId,
						preparation.envelopeId,
						preparation.recipientId,
						input.idempotencyKey
					].join(NUL)
				);
				const completedPayloadValue = {
					sentCommitSha: preparation.sentCommitSha,
					completedAt: signedAt
				};
				completedAuditPayloadJson = JSON.stringify(completedPayloadValue);
				completedAuditEventHash = await sha256(
					JSON.stringify({
						actorId: preparation.recipientId,
						envelopeId: preparation.envelopeId,
						eventType: 'envelope.completed',
						occurredAt: signedAt,
						organizationId: preparation.organizationId,
						payload: completedPayloadValue,
						previousHash: auditEventHash
					})
				);
			} else if (shouldRelease) {
				nextRoutingOrder = routing.nextRoutingOrder;
				nextCapabilityExpiresAt = new Date(
					Date.parse(signedAt) + NEXT_ROUTING_CAPABILITY_TTL_MS
				).toISOString();
				releasedDeliveryCount = routing.nextGroupCount;
			}

			const command: PublishRecipientSignedCommand = {
				...lookup,
				requestFingerprint,
				recipientRole: 'signer',
				routingOrder: preparation.routingOrder,
				expectedSentCommitSha: preparation.sentCommitSha,
				expectedFieldGeneration: input.expectedFieldGeneration,
				fieldValues,
				updatedAt: signedAt,
				nextRoutingOrder,
				nextCapabilityExpiresAt,
				releasedDeliveryCount,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson,
				completedAuditEventId,
				completedAuditEventHash,
				completedAuditPayloadJson
			};
			const published: PublishRecipientSignedResult = await this.store.publishSign(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			return published;
		}

		return { outcome: 'audit_conflict' };
	}
}

interface MatchedFieldValues {
	outcome: 'ok';
	fieldValues: readonly SignedFieldValue[];
}

type MatchFailure =
	| { outcome: 'invalid_field' }
	| { outcome: 'incomplete_field_set' }
	| { outcome: 'missing_required_value' };

async function replayExisting(
	preparation: Extract<SignPreparation, { outcome: 'existing' }>,
	input: RecipientSignedInput,
	capabilityHash: string
): Promise<RecipientSignedResult> {
	const matched: MatchedFieldValues | MatchFailure = await matchFieldValues(
		preparation.storedFields,
		input.values
	);
	if (matched.outcome !== 'ok') return { outcome: 'idempotency_conflict' };
	const requestFingerprint: string = await fingerprintFromFieldValues(
		input,
		capabilityHash,
		matched.fieldValues
	);
	if (requestFingerprint !== preparation.reconstructedFingerprint) {
		return { outcome: 'idempotency_conflict' };
	}
	return { outcome: 'replayed', result: preparation.result };
}

async function fingerprintFromFieldValues(
	input: RecipientSignedInput,
	capabilityHash: string,
	fieldValues: readonly SignedFieldValue[]
): Promise<string> {
	const values: SignFingerprintValue[] = [];
	for (const field of fieldValues) {
		const parsed: unknown = JSON.parse(field.valueJson) as unknown;
		if (typeof parsed !== 'string' && typeof parsed !== 'boolean') {
			throw new InvalidSignInputError('Normalized field value is invalid');
		}
		values.push({ fieldId: field.fieldId, value: parsed });
	}
	return sha256(
		canonicalRecipientSignFingerprint({
			envelopeId: input.expectedEnvelopeId,
			recipientId: input.expectedRecipientId,
			capabilityHash,
			expectedFieldGeneration: input.expectedFieldGeneration,
			values
		})
	);
}

async function matchFieldValues(
	declared: readonly SignableFieldDeclaration[],
	submitted: readonly SignFieldValueInput[]
): Promise<MatchedFieldValues | MatchFailure> {
	if (submitted.length !== declared.length) return { outcome: 'incomplete_field_set' };

	const declaredById: Map<string, SignableFieldDeclaration> = new Map(
		declared.map((field: SignableFieldDeclaration): [string, SignableFieldDeclaration] => [
			field.id,
			field
		])
	);
	const submittedIds: Set<string> = new Set(
		submitted.map((entry: SignFieldValueInput): string => entry.fieldId)
	);
	if (submittedIds.size !== declared.length) return { outcome: 'incomplete_field_set' };
	for (const field of declared) {
		if (!submittedIds.has(field.id)) return { outcome: 'incomplete_field_set' };
	}

	const values: SignedFieldValue[] = [];
	for (const entry of submitted) {
		const field: SignableFieldDeclaration | undefined = declaredById.get(entry.fieldId);
		if (field === undefined) return { outcome: 'invalid_field' };
		const validated: string | boolean | null = validateFieldValue(field.fieldType, entry.value);
		if (validated === null) return { outcome: 'invalid_field' };
		if (field.required && isEmptyValue(field.fieldType, validated)) {
			return { outcome: 'missing_required_value' };
		}
		const valueJson: string = JSON.stringify(validated);
		values.push({
			fieldId: field.id,
			fieldType: field.fieldType,
			valueJson,
			valueSha256: await sha256(valueJson)
		});
	}
	values.sort((left: SignedFieldValue, right: SignedFieldValue): number =>
		left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0
	);
	return { outcome: 'ok', fieldValues: values };
}

function validateFieldValue(
	fieldType: FieldType,
	value: string | boolean
): string | boolean | null {
	if (fieldType === 'checkbox') {
		return typeof value === 'boolean' ? value : null;
	}
	if (typeof value !== 'string') return null;
	const trimmed: string = value.trim();
	if (hasControlCharacter(trimmed)) return null;

	if (fieldType === 'date') {
		if (trimmed.length === 0) return trimmed;
		if (!DATE_PATTERN.test(trimmed) || !isRealCalendarDate(trimmed)) return null;
		return trimmed;
	}
	const maxLength: number =
		fieldType === 'signature'
			? MAX_SIGNATURE_LENGTH
			: fieldType === 'initials'
				? MAX_INITIALS_LENGTH
				: MAX_TEXT_LENGTH;
	if (trimmed.length > maxLength) return null;
	return trimmed;
}

function isEmptyValue(fieldType: FieldType, value: string | boolean): boolean {
	if (fieldType === 'checkbox') return value === false;
	return value === '';
}

function isRealCalendarDate(value: string): boolean {
	const [year, month, day] = value.split('-').map(Number);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	const leapYear: boolean = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth: readonly number[] = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	];
	return day <= daysInMonth[month - 1];
}

function assertSignInput(
	expectedFieldGeneration: number,
	values: readonly SignFieldValueInput[]
): void {
	if (
		!Number.isSafeInteger(expectedFieldGeneration) ||
		expectedFieldGeneration < 0 ||
		expectedFieldGeneration >= MAX_GENERATION
	) {
		throw new InvalidSignInputError('expectedFieldGeneration is out of range');
	}
	if (values.length > MAX_FIELD_COUNT) {
		throw new InvalidSignInputError(`Signing accepts at most ${MAX_FIELD_COUNT} field values`);
	}
	const seen: Set<string> = new Set<string>();
	for (const entry of values) {
		if (!UUID_PATTERN.test(entry.fieldId)) {
			throw new InvalidSignInputError('Field ID is invalid');
		}
		if (seen.has(entry.fieldId)) {
			throw new InvalidSignInputError('Duplicate field ID in submission');
		}
		seen.add(entry.fieldId);
		if (typeof entry.value !== 'string' && typeof entry.value !== 'boolean') {
			throw new InvalidSignInputError('Field value must be a string or boolean');
		}
		if (typeof entry.value === 'string' && entry.value.length > MAX_TEXT_LENGTH) {
			throw new InvalidSignInputError('Field value is too long');
		}
	}
}

function hasControlCharacter(value: string): boolean {
	for (let index: number = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}
