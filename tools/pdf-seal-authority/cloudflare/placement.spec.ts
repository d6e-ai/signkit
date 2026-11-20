import { describe, expect, it, vi } from 'vitest';
import { SEAL_LOCATION_HINTS, isSealLocationHint, placedObject } from './placement';

function namespace() {
	const getByName = vi.fn(
		(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) => ({
			name,
			options
		})
	);
	return { ns: { getByName } as unknown as DurableObjectNamespace, getByName };
}

describe('seal container placement', () => {
	it('keeps the historical unhinted object when no hint is set', () => {
		for (const hint of [undefined, '']) {
			const { ns, getByName } = namespace();
			placedObject(ns, 'sign', hint);
			expect(getByName).toHaveBeenCalledWith('sign');
		}
	});

	it('addresses a new hinted object, because an existing object never relocates', () => {
		const { ns, getByName } = namespace();
		placedObject(ns, 'sign', 'apac-se');
		expect(getByName).toHaveBeenCalledWith('sign-apac-se', { locationHint: 'apac-se' });
	});

	it('fails closed on an unknown hint instead of ignoring it', () => {
		const { ns, getByName } = namespace();
		expect(placedObject(ns, 'validate', 'asia')).toBeNull();
		expect(getByName).not.toHaveBeenCalled();
	});

	it('matches the release manifest hints', async () => {
		// A non-literal specifier keeps the untyped release script out of this project's type check.
		const releaseScript = '../deploy-cloudflare.mjs';
		const { SEAL_LOCATION_HINTS: releaseHints } = (await import(
			/* @vite-ignore */ releaseScript
		)) as {
			SEAL_LOCATION_HINTS: readonly string[];
		};
		expect(releaseHints).toEqual(SEAL_LOCATION_HINTS);
		expect(isSealLocationHint('apac-ne')).toBe(true);
		expect(isSealLocationHint('sin1')).toBe(false);
	});
});
