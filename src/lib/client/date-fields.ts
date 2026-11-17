import { canonicalizeTimeZone, type DateFieldOptions } from '$lib/domain/signing-date';

export { dateOptionsProperties as dateFieldOptions } from '$lib/domain/signing-date';

export function parseDateFieldOptions(field: {
	fieldType: unknown;
	dateMode?: unknown;
	dateTimeZone?: unknown;
}): DateFieldOptions | null {
	if (field.dateMode === undefined && field.dateTimeZone === undefined) return {};
	if (
		field.fieldType !== 'date' ||
		field.dateMode !== 'signed_at' ||
		typeof field.dateTimeZone !== 'string' ||
		field.dateTimeZone.length === 0
	)
		return null;
	if (canonicalizeTimeZone(field.dateTimeZone) === null) return null;
	return { dateMode: 'signed_at', dateTimeZone: field.dateTimeZone };
}
