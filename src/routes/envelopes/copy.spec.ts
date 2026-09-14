import { describe, expect, it } from 'vitest';

describe('envelope list product copy', () => {
	it('describes the product in plain end-user terms, never implementation architecture', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const description of [en.envelope_list_description, ja.envelope_list_description]) {
			expect(description).not.toMatch(/envelope/i);
			expect(description).not.toMatch(/recipient graph/i);
			expect(description).not.toMatch(/git/i);
			expect(description).not.toMatch(/commit/i);
		}
	});

	it('keeps the meaning: an agreement and its signers stay together from drafting through signature', async () => {
		const en = (await import('../../../messages/en.json')).default;
		expect(en.envelope_list_description).toMatch(/agreement/i);
		expect(en.envelope_list_description).toMatch(/sign/i);
	});
});
