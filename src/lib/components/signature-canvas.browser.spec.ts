import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { SIGNATURE_ASSET_REF_PREFIX } from '$lib/application/documents/signature-asset';
import SignatureCanvasTestHost from './signature-canvas-test-host.svelte';

const assetRef = `${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(64)}`;

test('keeps the field empty until the dialog is confirmed, including a prefilled typed name', async () => {
	const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });

	await expect.element(screen.getByRole('button', { name: 'Add signature' })).toBeVisible();
	expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');

	await screen.getByRole('button', { name: 'Add signature' }).click();
	const dialog = screen.getByRole('dialog', { name: 'Add your signature' });
	await expect.element(dialog).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Close' })).toBeVisible();
	await expect
		.element(screen.getByRole('tab', { name: 'Type' }))
		.toHaveAttribute('aria-selected', 'true');
	const typed = screen.getByLabelText('Typed signature');
	await expect.element(typed).toHaveValue('Alex Rivera');
	await expect.element(typed).toHaveFocus();
	await typed.fill('   ');
	await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();

	await screen.getByRole('button', { name: 'Cancel' }).click();
	await expect.element(screen.getByRole('button', { name: 'Add signature' })).toBeVisible();
	expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');

	await screen.getByRole('button', { name: 'Add signature' }).click();
	await screen.getByRole('button', { name: 'Use this signature' }).click();
	await expect.element(screen.getByRole('button', { name: 'Alex Rivera' })).toBeVisible();
	expect(screen.getByTestId('committed-signature').element().textContent).toBe('Alex Rivera');
});

test('reopening a confirmed typed signature shows that value, not a discarded edit', async () => {
	const screen = await render(SignatureCanvasTestHost, {
		recipientName: 'Alex Rivera',
		initialValue: 'Jordan Lee'
	});

	await screen.getByRole('button', { name: 'Jordan Lee' }).click();
	const typed = screen.getByLabelText('Typed signature');
	await expect.element(typed).toHaveFocus();
	await expect.element(typed).toHaveValue('Jordan Lee');
	await typed.fill('Discarded draft');
	await screen.getByRole('button', { name: 'Cancel' }).click();
	expect(screen.getByTestId('committed-signature').element().textContent).toBe('Jordan Lee');

	await screen.getByRole('button', { name: 'Jordan Lee' }).click();
	await expect.element(screen.getByLabelText('Typed signature')).toHaveValue('Jordan Lee');
});

test('draw mode needs an uploaded asset before confirm, and upload errors stay in the dialog', async () => {
	const originalFetch = window.fetch;
	window.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();

		const canvas = screen.getByLabelText('Signature', { exact: true });
		const node = canvas.element() as HTMLCanvasElement;
		node.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerId: 1 })
		);
		node.dispatchEvent(
			new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 30, pointerId: 1 })
		);
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));

		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('Could not save your drawn signature');
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
	} finally {
		window.fetch = originalFetch;
	}
});

test('clearing a drawing invalidates an in-flight upload', async () => {
	const originalFetch = window.fetch;
	let finish: ((response: Response) => void) | undefined;
	window.fetch = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();

		const canvas = screen.getByLabelText('Signature', { exact: true });
		const node = canvas.element() as HTMLCanvasElement;
		node.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerId: 1 })
		);
		node.dispatchEvent(
			new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 30, pointerId: 1 })
		);
		node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));

		await expect.element(screen.getByRole('button', { name: 'Saving signature…' })).toBeVisible();
		await screen.getByRole('button', { name: 'Clear' }).click();
		finish?.(
			new Response(JSON.stringify({ assetRef }), {
				status: 201,
				headers: { 'content-type': 'application/json' }
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
		expect(screen.container.textContent).not.toContain('Drawn signature saved');
	} finally {
		window.fetch = originalFetch;
	}
});

test('confirming a previously saved drawn signature keeps the asset ref contract', async () => {
	const screen = await render(SignatureCanvasTestHost, {
		recipientName: 'Alex Rivera',
		initialValue: assetRef
	});

	await expect.element(screen.getByRole('button', { name: 'Drawn signature' })).toBeVisible();
	await screen.getByRole('button', { name: 'Drawn signature' }).click();
	await expect
		.element(screen.getByRole('tab', { name: 'Draw' }))
		.toHaveAttribute('aria-selected', 'true');
	await screen.getByRole('button', { name: 'Use this signature' }).click();
	expect(screen.getByTestId('committed-signature').element().textContent).toBe(assetRef);
});
