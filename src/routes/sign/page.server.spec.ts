import { describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';

describe('bare /sign load', () => {
	it('fails closed without inspecting cookies, including when cookies are present', async () => {
		const get = vi.fn();
		const page = await load({
			cookies: { get, delete: vi.fn(), set: vi.fn() },
			setHeaders: vi.fn(),
			url: new URL('https://signkit.example/sign')
		} as never);

		expect(page).toEqual({ state: 'invalid' });
		expect(get).not.toHaveBeenCalled();
	});

	it('honors an explicit unavailable access hint without guessing a cookie', async () => {
		const get = vi.fn();
		const page = await load({
			cookies: { get, delete: vi.fn(), set: vi.fn() },
			setHeaders: vi.fn(),
			url: new URL('https://signkit.example/sign?access=unavailable')
		} as never);

		expect(page).toEqual({ state: 'unavailable' });
		expect(get).not.toHaveBeenCalled();
	});
});
