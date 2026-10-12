import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import NewEnvelopePage from './+page.svelte';

const { goto } = vi.hoisted(() => ({ goto: vi.fn(async () => undefined) }));
vi.mock('$app/navigation', () => ({ goto }));
afterEach(() => {
	vi.unstubAllGlobals();
	goto.mockClear();
});

it('explains an empty title instead of leaving the primary action disabled', async () => {
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	const screen = await render(NewEnvelopePage);
	const create = screen.getByRole('button', { name: 'Create envelope' });
	await expect.element(create).toBeEnabled();
	await create.click();
	await expect.element(screen.getByText('Enter a title.')).toBeVisible();
	await expect.element(screen.getByLabelText('Title')).toHaveFocus();
	await expect.element(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
	expect(fetch).not.toHaveBeenCalled();
	expect(goto).not.toHaveBeenCalled();
});

it('preserves a valid title after a service failure without marking the title invalid', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						type: 'urn:signkit:problem:service-unavailable',
						title: 'Unavailable',
						status: 503,
						detail: 'Could not create the envelope.'
					}),
					{ status: 503, headers: { 'content-type': 'application/problem+json' } }
				)
		)
	);
	const screen = await render(NewEnvelopePage);
	await screen.getByLabelText('Title').fill('Test agreement');
	await screen.getByRole('button', { name: 'Create envelope' }).click();
	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('Could not create the envelope.');
	await expect.element(screen.getByLabelText('Title')).toHaveValue('Test agreement');
	expect(screen.getByLabelText('Title').element().getAttribute('aria-invalid')).not.toBe('true');
	expect(goto).not.toHaveBeenCalled();
});
