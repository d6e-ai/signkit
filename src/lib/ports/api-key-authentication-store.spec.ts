import { describe, expect, it } from 'vitest';
import {
	ORGANIZATION_SELECTOR_PATTERN,
	SIGNKIT_ORGANIZATION_HEADER,
	isOrganizationSelector
} from './api-key-authentication-store';

describe('organization selector contract', () => {
	it('names the header in the lowercase form Headers.get expects', () => {
		expect(SIGNKIT_ORGANIZATION_HEADER).toBe('signkit-organization-id');
		expect(
			new Headers({ 'SignKit-Organization-Id': 'org-alpha' }).get(SIGNKIT_ORGANIZATION_HEADER)
		).toBe('org-alpha');
	});

	it('accepts external d6e organization identifier shapes', () => {
		expect(isOrganizationSelector('org-alpha')).toBe(true);
		expect(isOrganizationSelector('org_d6e_01K9ZQ')).toBe(true);
		// Deliberately not a UUIDv7 check: the organization identifier is external
		// and SignKit only projects it.
		expect(isOrganizationSelector('9f1c6f8e-0a1d-4f3b-8b0e-7c2f9a4d6e11')).toBe(true);
		expect(isOrganizationSelector('x')).toBe(true);
		expect(isOrganizationSelector('o'.repeat(200))).toBe(true);
	});

	it('rejects a missing, empty, overlong, or non-printable selector', () => {
		expect(isOrganizationSelector(null)).toBe(false);
		expect(isOrganizationSelector('')).toBe(false);
		expect(isOrganizationSelector('o'.repeat(201))).toBe(false);
		expect(isOrganizationSelector('org alpha')).toBe(false);
		expect(isOrganizationSelector('org\talpha')).toBe(false);
		expect(isOrganizationSelector('org\nalpha')).toBe(false);
		expect(isOrganizationSelector('org\u00e9')).toBe(false);
		expect(isOrganizationSelector('org\u00a0alpha')).toBe(false);
	});

	it('keeps the bound in step with the SQL organization_id checks', () => {
		// Both dialects bound organization_id to 1..200 printable ASCII, so a value
		// this pattern admits must be storable and vice versa.
		expect(ORGANIZATION_SELECTOR_PATTERN.source).toBe('^[!-~]{1,200}$');
	});
});
