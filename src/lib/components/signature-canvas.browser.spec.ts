import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { SIGNATURE_ASSET_REF_PREFIX } from '$lib/application/documents/signature-asset';
import SignatureCanvasTestHost from './signature-canvas-test-host.svelte';

const assetRef = `${SIGNATURE_ASSET_REF_PREFIX}${'a'.repeat(64)}`;
const secondAssetRef = `${SIGNATURE_ASSET_REF_PREFIX}${'b'.repeat(64)}`;

interface FetchRecorder {
	calls: number;
	restore(): void;
}

/** Replaces `window.fetch` and counts every call the component makes. */
function recordFetch(respond: (call: number) => Promise<Response>): FetchRecorder {
	const original = window.fetch;
	const recorder: FetchRecorder = {
		calls: 0,
		restore: (): void => {
			window.fetch = original;
		}
	};
	window.fetch = (async (): Promise<Response> => {
		recorder.calls += 1;
		return respond(recorder.calls);
	}) as typeof fetch;
	return recorder;
}

function jsonResponse(ref: string): Response {
	return new Response(JSON.stringify({ assetRef: ref }), {
		status: 201,
		headers: { 'content-type': 'application/json' }
	});
}

function draw(canvas: HTMLCanvasElement, offset: number = 0): void {
	canvas.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			clientX: 10 + offset,
			clientY: 10,
			pointerId: 1
		})
	);
	canvas.dispatchEvent(
		new PointerEvent('pointermove', {
			bubbles: true,
			clientX: 40 + offset,
			clientY: 30,
			pointerId: 1
		})
	);
	canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
}

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

test('drawing uploads nothing, and confirming uploads exactly once', async () => {
	const recorder = recordFetch(async () => jsonResponse(assetRef));
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();

		const canvas = screen.getByLabelText('Signature', { exact: true });
		const node = canvas.element() as HTMLCanvasElement;
		draw(node);
		// Pointer events only touch the local canvas. Nothing leaves the browser
		// until the signer says this is their signature.
		draw(node, 20);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(recorder.calls).toBe(0);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeEnabled();

		await screen.getByRole('button', { name: 'Use this signature' }).click();
		await expect.element(screen.getByRole('button', { name: 'Drawn signature' })).toBeVisible();
		expect(recorder.calls).toBe(1);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe(assetRef);
	} finally {
		recorder.restore();
	}
});

test('a failed upload keeps the dialog open and commits nothing', async () => {
	const recorder = recordFetch(async () => new Response('nope', { status: 500 }));
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		const canvas = screen.getByLabelText('Signature', { exact: true });
		draw(canvas.element() as HTMLCanvasElement);
		expect(recorder.calls).toBe(0);

		await screen.getByRole('button', { name: 'Use this signature' }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('Could not save your drawn signature');
		// Still open, still one attempt, still nothing committed.
		await expect.element(screen.getByRole('dialog', { name: 'Add your signature' })).toBeVisible();
		expect(recorder.calls).toBe(1);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
	} finally {
		recorder.restore();
	}
});

test('confirming an unchanged previously drawn signature reuses the asset without uploading', async () => {
	const recorder = recordFetch(async () => jsonResponse(secondAssetRef));
	try {
		const screen = await render(SignatureCanvasTestHost, {
			recipientName: 'Alex Rivera',
			initialValue: assetRef
		});

		await screen.getByRole('button', { name: 'Drawn signature' }).click();
		await expect
			.element(screen.getByRole('tab', { name: 'Draw' }))
			.toHaveAttribute('aria-selected', 'true');
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeEnabled();
		await screen.getByRole('button', { name: 'Use this signature' }).click();

		expect(recorder.calls).toBe(0);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe(assetRef);
	} finally {
		recorder.restore();
	}
});

test('a redraw never reuses the previously committed asset, and a failed redraw commits nothing', async () => {
	const recorder = recordFetch(async () => new Response('nope', { status: 500 }));
	try {
		const screen = await render(SignatureCanvasTestHost, {
			recipientName: 'Alex Rivera',
			initialValue: assetRef
		});

		await screen.getByRole('button', { name: 'Drawn signature' }).click();
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeEnabled();

		const canvas = screen.getByLabelText('Signature', { exact: true });
		draw(canvas.element() as HTMLCanvasElement);
		await screen.getByRole('button', { name: 'Use this signature' }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('Could not save your drawn signature');
		expect(recorder.calls).toBe(1);
		// The old asset is still the committed value, but the dialog will not
		// silently re-confirm it now that the canvas shows something else.
		expect(screen.getByTestId('committed-signature').element().textContent).toBe(assetRef);

		await screen.getByRole('button', { name: 'Cancel' }).click();
		await expect.element(screen.getByRole('button', { name: 'Drawn signature' })).toBeVisible();
		expect(screen.getByTestId('committed-signature').element().textContent).toBe(assetRef);
	} finally {
		recorder.restore();
	}
});

test('clearing during an upload discards the stale response', async () => {
	let finish: ((response: Response) => void) | undefined;
	const recorder = recordFetch(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		const canvas = screen.getByLabelText('Signature', { exact: true });
		draw(canvas.element() as HTMLCanvasElement);
		await screen.getByRole('button', { name: 'Use this signature' }).click();
		await expect.element(screen.getByRole('button', { name: 'Saving signature…' })).toBeVisible();

		await screen.getByRole('button', { name: 'Clear' }).click();
		finish?.(jsonResponse(assetRef));
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(recorder.calls).toBe(1);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
		await expect.element(screen.getByRole('dialog', { name: 'Add your signature' })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Use this signature' })).toBeDisabled();
	} finally {
		recorder.restore();
	}
});

test('cancelling during an upload never commits the late response', async () => {
	let finish: ((response: Response) => void) | undefined;
	const recorder = recordFetch(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		const canvas = screen.getByLabelText('Signature', { exact: true });
		draw(canvas.element() as HTMLCanvasElement);
		await screen.getByRole('button', { name: 'Use this signature' }).click();
		await expect.element(screen.getByRole('button', { name: 'Saving signature…' })).toBeVisible();

		await screen.getByRole('button', { name: 'Cancel' }).click();
		finish?.(jsonResponse(assetRef));
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(recorder.calls).toBe(1);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('(empty)');
		await expect.element(screen.getByRole('button', { name: 'Add signature' })).toBeVisible();
	} finally {
		recorder.restore();
	}
});

test('switching modes after drawing abandons the drawing rather than uploading it', async () => {
	const recorder = recordFetch(async () => jsonResponse(assetRef));
	try {
		const screen = await render(SignatureCanvasTestHost, { recipientName: 'Alex Rivera' });
		await screen.getByRole('button', { name: 'Add signature' }).click();
		await screen.getByRole('tab', { name: 'Draw' }).click();
		const canvas = screen.getByLabelText('Signature', { exact: true });
		draw(canvas.element() as HTMLCanvasElement);

		await screen.getByRole('tab', { name: 'Type' }).click();
		await screen.getByLabelText('Typed signature').fill('Alex Rivera');
		await screen.getByRole('button', { name: 'Use this signature' }).click();

		expect(recorder.calls).toBe(0);
		expect(screen.getByTestId('committed-signature').element().textContent).toBe('Alex Rivera');
	} finally {
		recorder.restore();
	}
});
