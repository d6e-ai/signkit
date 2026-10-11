import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import Input from './input.svelte';

describe('file input', () => {
	it('can clear a selection and upload the same file again without assigning a filename', async () => {
		const selections: string[][] = [];
		const screen = await render(Input, {
			type: 'file',
			'data-testid': 'file-input',
			onchange: (event) => {
				selections.push(Array.from(event.currentTarget.files ?? [], (file) => file.name));
				event.currentTarget.value = '';
			}
		});
		const file = new File(['synthetic fixture'], 'contract.pdf', { type: 'application/pdf' });
		const input = screen.getByTestId('file-input');

		await userEvent.upload(input, file);
		await expect.element(input).toHaveValue('');
		await userEvent.upload(input, file);
		await expect.element(input).toHaveValue('');
		expect(selections).toEqual([['contract.pdf'], ['contract.pdf']]);
	});
});
