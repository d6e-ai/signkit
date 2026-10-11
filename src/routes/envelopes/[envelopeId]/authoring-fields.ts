import {
	fieldTypes,
	isDraftPath,
	type DraftPath,
	type FieldGeometry,
	type FieldType
} from '$lib/domain/envelope';
import type { AuthoringFieldResponse, AuthoringFieldsResponse } from '$lib/client/envelopes';

/**
 * The exact revision an authoring GET must agree with before its field set
 * is safe to use as the editable baseline: a mismatch on any of these means
 * the envelope moved (re-readied, reopened, or re-published) since this read
 * was issued, so the read must be treated as stale rather than hydrated.
 */
export interface AuthoringFieldsRevision {
	generation: number;
	fieldGeneration: number;
	commitSha: string | null;
}

export interface AuthoringFieldRecord {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: DraftPath | null;
	fieldType: FieldType;
	label: string;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

/**
 * The label-free public detail projection used to prove a GET /fields body
 * is the complete current set rather than a subset or a mismatched rewrite.
 */
export interface PublicAuthoringFieldProjection {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: string | null;
	fieldType: FieldType;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

export interface AuthoringFieldsKnownLinks {
	recipientIds: ReadonlySet<string>;
	documentIds: ReadonlySet<string>;
}

/**
 * Parses a GET /fields body without inventing labels or dropping members.
 * Returns null when the payload is incomplete or malformed so callers never
 * treat a truncated set as the complete persisted baseline.
 */
export function parseAuthoringFieldsResponse(data: unknown): AuthoringFieldsResponse | null {
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
	const record = data as Record<string, unknown>;
	if (typeof record.envelopeId !== 'string' || record.envelopeId.length === 0) return null;
	if (!isNonNegativeInt(record.generation) || !isNonNegativeInt(record.fieldGeneration))
		return null;
	if (record.commitSha !== null && typeof record.commitSha !== 'string') return null;
	if (!Array.isArray(record.fields)) return null;
	const fields: AuthoringFieldResponse[] = [];
	for (const item of record.fields) {
		const field = parseAuthoringField(item);
		if (field === null) return null;
		fields.push(field);
	}
	return {
		envelopeId: record.envelopeId,
		generation: record.generation,
		fieldGeneration: record.fieldGeneration,
		commitSha: record.commitSha,
		fields
	};
}

/**
 * Accepts a GET /fields response only when it names this exact envelope and
 * revision, every field is a complete definition, IDs are unique, the count
 * and public metadata match the current detail projection, and every
 * recipient/document link is known. Returns null (never a partial array)
 * otherwise, so a caller can never silently replace a complete persisted set
 * with a stale, truncated, or relabelled one.
 */
export function acceptAuthoringFields(
	response: AuthoringFieldsResponse,
	envelopeId: string,
	revision: AuthoringFieldsRevision,
	publicFields: readonly PublicAuthoringFieldProjection[],
	knownLinks?: AuthoringFieldsKnownLinks
): readonly AuthoringFieldRecord[] | null {
	if (response.envelopeId !== envelopeId) return null;
	if (response.generation !== revision.generation) return null;
	if (response.fieldGeneration !== revision.fieldGeneration) return null;
	if (response.commitSha !== revision.commitSha) return null;
	if (response.fields.length !== publicFields.length) return null;

	const publicById = new Map<string, PublicAuthoringFieldProjection>();
	for (const projected of publicFields) {
		if (publicById.has(projected.id)) return null;
		publicById.set(projected.id, projected);
	}
	if (publicById.size !== publicFields.length) return null;

	const records: AuthoringFieldRecord[] = [];
	const seenIds = new Set<string>();
	for (const field of response.fields) {
		const record = toAuthoringFieldRecord(field);
		if (record === null) return null;
		if (seenIds.has(record.id)) return null;
		seenIds.add(record.id);
		const projected = publicById.get(record.id);
		if (projected === undefined) return null;
		if (!samePublicMetadata(record, projected)) return null;
		if (knownLinks !== undefined && !linksAreKnown(record, knownLinks)) return null;
		records.push(record);
	}
	return records;
}

function samePublicMetadata(
	record: AuthoringFieldRecord,
	projected: PublicAuthoringFieldProjection
): boolean {
	return (
		record.recipientId === projected.recipientId &&
		record.documentId === projected.documentId &&
		record.documentPath === projected.documentPath &&
		record.fieldType === projected.fieldType &&
		record.required === projected.required &&
		record.position === projected.position &&
		sameGeometry(record.geometry, projected.geometry)
	);
}

function sameGeometry(left: FieldGeometry | null, right: FieldGeometry | null): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.page === right.page &&
		left.x === right.x &&
		left.y === right.y &&
		left.width === right.width &&
		left.height === right.height
	);
}

function linksAreKnown(
	record: AuthoringFieldRecord,
	knownLinks: AuthoringFieldsKnownLinks
): boolean {
	if (!knownLinks.recipientIds.has(record.recipientId)) return false;
	if (record.documentId !== null && !knownLinks.documentIds.has(record.documentId)) return false;
	return true;
}

function parseAuthoringField(data: unknown): AuthoringFieldResponse | null {
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
	const field = data as Record<string, unknown>;
	if (typeof field.id !== 'string' || field.id.length === 0) return null;
	if (typeof field.recipientId !== 'string' || field.recipientId.length === 0) return null;
	if (!isFieldType(field.fieldType)) return null;
	if (typeof field.label !== 'string') return null;
	if (typeof field.required !== 'boolean') return null;
	if (!isNonNegativeInt(field.position)) return null;
	const documentId = parseNullableString(field.documentId);
	if (documentId === false) return null;
	const documentPath = parseNullableDocumentPath(field.documentPath);
	if (documentPath === false) return null;
	const geometry = parseNullableGeometry(field.geometry);
	if (geometry === false) return null;
	return {
		id: field.id,
		recipientId: field.recipientId,
		documentId,
		documentPath,
		fieldType: field.fieldType,
		label: field.label,
		required: field.required,
		position: field.position,
		geometry
	};
}

function toAuthoringFieldRecord(field: AuthoringFieldResponse): AuthoringFieldRecord | null {
	if (!isFieldType(field.fieldType) || typeof field.label !== 'string') return null;
	if (typeof field.required !== 'boolean' || !isNonNegativeInt(field.position)) return null;
	if (typeof field.id !== 'string' || typeof field.recipientId !== 'string') return null;
	const geometry = parseNullableGeometry(field.geometry);
	if (geometry === false) return null;
	const documentId = parseNullableString(field.documentId);
	if (documentId === false) return null;
	const documentPath = parseNullableDocumentPath(field.documentPath);
	if (documentPath === false) return null;
	return {
		id: field.id,
		recipientId: field.recipientId,
		documentId,
		documentPath,
		fieldType: field.fieldType,
		label: field.label,
		required: field.required,
		position: field.position,
		geometry
	};
}

function parseNullableString(value: unknown): string | null | false {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') return false;
	return value;
}

function parseNullableDocumentPath(value: unknown): DraftPath | null | false {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || !isDraftPath(value)) return false;
	return value;
}

function parseNullableGeometry(value: unknown): FieldGeometry | null | false {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) return false;
	const geometry = value as Record<string, unknown>;
	if (!isPositiveInt(geometry.page)) return false;
	if (!isUnitFraction(geometry.x) || !isUnitFraction(geometry.y)) return false;
	if (!isPositiveUnitFraction(geometry.width) || !isPositiveUnitFraction(geometry.height)) {
		return false;
	}
	return {
		page: geometry.page,
		x: geometry.x,
		y: geometry.y,
		width: geometry.width,
		height: geometry.height
	};
}

function isFieldType(value: unknown): value is FieldType {
	return typeof value === 'string' && (fieldTypes as readonly string[]).includes(value);
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isUnitFraction(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveUnitFraction(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}
