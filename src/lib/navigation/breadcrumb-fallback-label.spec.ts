import { describe, expect, it } from 'vitest';
import { breadcrumbFallbackLabel } from './breadcrumb-fallback-label';

describe('breadcrumbFallbackLabel', () => {
	it('humanizes a dashed path segment', () => {
		expect(breadcrumbFallbackLabel('/some-route')).toBe('Some Route');
	});

	it('uses the last segment of a nested path', () => {
		expect(breadcrumbFallbackLabel('/parent/child-route')).toBe('Child Route');
	});

	it('ignores a trailing slash', () => {
		expect(breadcrumbFallbackLabel('/some-route/')).toBe('Some Route');
	});

	it('returns null for the root path, so only the brand crumb renders', () => {
		expect(breadcrumbFallbackLabel('/')).toBeNull();
	});
});
