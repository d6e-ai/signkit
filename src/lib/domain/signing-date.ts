/**
 * Server-owned automatic signing dates.
 *
 * A `date` field is manual unless it carries `dateMode: 'signed_at'`. An
 * automatic field is frozen with an IANA `dateTimeZone` at placement and is
 * filled by the server from the exact signing instant, never from client input.
 * Legacy/manual fields omit BOTH options so their canonical bytes never change.
 */
export const dateModes = ['signed_at'] as const;
export type DateMode = (typeof dateModes)[number];

export interface DateFieldOptions {
	dateMode?: DateMode;
	dateTimeZone?: string;
}

export class InvalidDateFieldOptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidDateFieldOptionsError';
	}
}

export function isDateSignedField(field: { fieldType: string; dateMode?: string | null }): boolean {
	return field.fieldType === 'date' && field.dateMode === 'signed_at';
}

const TIME_ZONE_PATTERN: RegExp = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const MAX_TIME_ZONE_LENGTH: number = 64;

/** Canonical IANA name via Intl, or null for anything that is not a real zone. */
export function canonicalizeTimeZone(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) {
		return null;
	}
	if (!TIME_ZONE_PATTERN.test(value)) return null;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

/**
 * Validates and canonicalizes the optional date options for one field. Both
 * options must be supplied together and only on `date` fields; anything else
 * throws rather than being silently dropped. Returns `{}` for manual fields.
 */
export function canonicalizeDateFieldOptions(
	fieldType: string,
	options: { dateMode?: unknown; dateTimeZone?: unknown }
): DateFieldOptions {
	const hasMode: boolean = options.dateMode !== undefined;
	const hasZone: boolean = options.dateTimeZone !== undefined;
	if (!hasMode && !hasZone) return {};
	if (fieldType !== 'date') {
		throw new InvalidDateFieldOptionsError('Date options are only valid on date fields');
	}
	if (!hasMode || !hasZone) {
		throw new InvalidDateFieldOptionsError('dateMode and dateTimeZone must be supplied together');
	}
	if (options.dateMode !== 'signed_at') {
		throw new InvalidDateFieldOptionsError('dateMode is invalid');
	}
	const zone: string | null = canonicalizeTimeZone(options.dateTimeZone);
	if (zone === null)
		throw new InvalidDateFieldOptionsError('dateTimeZone is not a valid IANA time zone');
	return { dateMode: 'signed_at', dateTimeZone: zone };
}

/**
 * Reads options from nullable storage columns. Both null is a manual field;
 * exactly one set, an unknown mode or a non-date field is corrupt (returns
 * null). The stored zone is trusted as already canonical but re-validated.
 */
export function dateFieldOptionsFromColumns(
	fieldType: string,
	mode: string | null | undefined,
	zone: string | null | undefined
): DateFieldOptions | null {
	const noMode: boolean = mode === null || mode === undefined;
	const noZone: boolean = zone === null || zone === undefined;
	if (noMode && noZone) return {};
	if (noMode || noZone || fieldType !== 'date' || mode !== 'signed_at') return null;
	if (zone === null || zone === undefined || canonicalizeTimeZone(zone) === null) return null;
	return { dateMode: 'signed_at', dateTimeZone: zone };
}

/** `YYYY-MM-DD` for the instant in the given zone (Gregorian, Latin digits). */
export function formatSigningDate(signedAt: string, timeZone: string): string {
	const instant: Date = new Date(signedAt);
	if (Number.isNaN(instant.getTime())) throw new RangeError('signedAt is not a valid instant');
	const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(instant);
	const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
	return `${pick('year').padStart(4, '0')}-${pick('month')}-${pick('day')}`;
}

/**
 * Proves the live `envelope_field` date options against the hash-chained
 * `envelope.fields_placed` payload they were frozen into. A field present in
 * the payload must carry identical options (both absent for manual fields); an
 * automatic field missing from the payload fails closed. Manual fields absent
 * from the payload are tolerated for historical field sets.
 */
export function placementDateOptionsMatch(
	payloadJson: string,
	fields: readonly (DateFieldOptions & { id: string })[]
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson) as unknown;
	} catch {
		return false;
	}
	const placed: unknown =
		typeof parsed === 'object' && parsed !== null
			? (parsed as { fields?: unknown }).fields
			: undefined;
	if (!Array.isArray(placed)) return false;
	const byId: Map<string, Record<string, unknown>> = new Map();
	for (const entry of placed) {
		if (typeof entry !== 'object' || entry === null) return false;
		const record = entry as Record<string, unknown>;
		if (typeof record.id === 'string') byId.set(record.id, record);
	}
	for (const field of fields) {
		const entry: Record<string, unknown> | undefined = byId.get(field.id);
		if (entry === undefined) {
			if (field.dateMode !== undefined) return false;
			continue;
		}
		if (entry.dateMode !== field.dateMode || entry.dateTimeZone !== field.dateTimeZone) {
			return false;
		}
	}
	return true;
}

/**
 * Publish-time proof that a command's values agree with the frozen field
 * declarations: every value carries the declaration's exact options, and every
 * automatic value equals the date derived from the command's signing instant.
 */
export function automaticDatesMatchDeclarations(
	declared: readonly (DateFieldOptions & { id: string })[],
	values: readonly (DateFieldOptions & { fieldId: string; valueJson: string })[],
	signedAt: string
): boolean {
	const declaredById: Map<string, DateFieldOptions> = new Map(
		declared.map((field): [string, DateFieldOptions] => [field.id, field])
	);
	for (const value of values) {
		const field: DateFieldOptions | undefined = declaredById.get(value.fieldId);
		if (field === undefined) return false;
		if (field.dateMode !== value.dateMode || field.dateTimeZone !== value.dateTimeZone) {
			return false;
		}
		if (field.dateMode === undefined) continue;
		try {
			if (
				value.valueJson !== JSON.stringify(formatSigningDate(signedAt, field.dateTimeZone ?? ''))
			) {
				return false;
			}
		} catch {
			return false;
		}
	}
	return true;
}

/** Spread-safe options: emits keys only for automatic fields. */
export function dateOptionsProperties(field: DateFieldOptions): DateFieldOptions {
	return field.dateMode === undefined
		? {}
		: { dateMode: field.dateMode, dateTimeZone: field.dateTimeZone };
}
