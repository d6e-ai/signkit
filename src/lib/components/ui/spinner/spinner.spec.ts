import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('spinner', () => {
	const source: string = readFileSync('src/lib/components/ui/spinner/spinner.svelte', 'utf8');

	it('uses the continuous circular Tabler loader instead of the segmented loader', () => {
		expect(source).toContain('@tabler/icons-svelte/icons/loader-2');
		expect(source).toContain('<IconLoader2');
		expect(source).not.toContain('import { IconLoader }');
	});
});
