import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SignPage from './[envelopeId]/+page.svelte';
import { pdfLoad } from './field-navigation-pdf-test-stub.svelte';
import type { PageData } from './[envelopeId]/$types';
import type { RecipientPlacedField } from '$lib/application/signing/recipient-workspace';
import '../layout.css';

vi.mock('$lib/components/pdf-document-view.svelte', async () => ({
	default: (await import('./field-navigation-pdf-test-stub.svelte')).default
}));

const ENVELOPE_ID = '01910000-0000-7000-8000-000000000001';
const DOCUMENT_A = '01910000-0000-7000-8000-000000000011';
const DOCUMENT_B = '01910000-0000-7000-8000-000000000012';
const FIELD_A = '01910000-0000-7000-8000-000000000021';
const FIELD_B = '01910000-0000-7000-8000-000000000022';
const src = (documentId: string) => `/sign/${ENVELOPE_ID}/documents/${documentId}.pdf`;

function fixture(role: 'signer' | 'approver' = 'signer'): PageData {
	const fields: RecipientPlacedField[] = [
		{
			id: FIELD_A,
			documentId: DOCUMENT_A,
			fieldType: 'text',
			label: 'Full name',
			required: true,
			geometry: { page: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.06 }
		},
		{
			id: FIELD_B,
			documentId: DOCUMENT_B,
			fieldType: 'text',
			label: 'Company',
			required: true,
			geometry: { page: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.06 }
		}
	];
	return {
		state: 'active',
		access: {
			envelopeId: ENVELOPE_ID,
			recipientId: '01910000-0000-7000-8000-000000000002',
			recipientName: 'Alex Rivera',
			role,
			locale: 'en',
			recipientStatus: 'viewed',
			envelopeTitle: 'Service Agreement',
			envelopeStatus: 'in_progress',
			expiresAt: '2026-11-30T00:00:00.000Z'
		},
		documents: [
			{
				documentId: DOCUMENT_A,
				position: 0,
				title: 'Agreement',
				kind: 'pdf',
				pageCount: 1,
				pageWidth: 595.28,
				pageHeight: 841.89
			},
			{
				documentId: DOCUMENT_B,
				position: 1,
				title: 'Schedule',
				kind: 'pdf',
				pageCount: 1,
				pageWidth: 595.28,
				pageHeight: 841.89
			}
		],
		source: 'document-set',
		fields: role === 'signer' ? fields : [],
		fieldGeneration: 1
	} as PageData;
}

beforeEach(async () => {
	await page.viewport(1280, 844);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

async function finish(documentId: string) {
	await expect.poll(() => pdfLoad(src(documentId))).toBeTypeOf('function');
	pdfLoad(src(documentId))!();
}

test('moves to the next missing field with the keyboard, waits for its document, and updates required progress', async () => {
	const screen = await render(SignPage, { data: fixture() });
	await finish(DOCUMENT_A);
	await screen.getByRole('textbox', { name: 'Full name — Text' }).fill('Alex Rivera');
	await expect.element(screen.getByText('1 of 2 required fields completed')).toBeVisible();
	const next = screen.getByRole('button', { name: 'Next required field' });
	next.element().focus();
	await userEvent.keyboard('{Enter}');
	await expect
		.element(screen.getByTestId('document-preview'))
		.toHaveAttribute('data-src', src(DOCUMENT_B));
	await expect
		.element(screen.getByRole('textbox', { name: 'Company — Text' }))
		.not.toBeInTheDocument();
	await finish(DOCUMENT_B);
	await expect.poll(() => document.activeElement?.id).toBe(FIELD_B);
	await screen.getByRole('textbox', { name: 'Company — Text' }).fill('Example Ltd');
	await expect.element(screen.getByText('2 of 2 required fields completed')).toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Next required field' }))
		.not.toBeInTheDocument();
	await expect
		.element(screen.getByRole('progressbar', { name: 'Required fields' }))
		.toHaveAttribute('aria-valuenow', '2');
});

test('names field destinations with document and page and switches documents before focusing', async () => {
	const screen = await render(SignPage, { data: fixture() });
	await finish(DOCUMENT_A);
	await screen.getByRole('button', { name: 'All fields (2)' }).click();
	await screen
		.getByRole('button', { name: 'Go to Company — Schedule, page 1', exact: true })
		.click();
	await expect
		.element(screen.getByTestId('document-preview'))
		.toHaveAttribute('data-src', src(DOCUMENT_B));
	await finish(DOCUMENT_B);
	await expect.poll(() => document.activeElement?.id).toBe(FIELD_B);
});

test('does not let an obsolete document load steal focus after manual document navigation', async () => {
	const screen = await render(SignPage, { data: fixture() });
	await finish(DOCUMENT_A);
	await screen.getByRole('button', { name: 'All fields (2)' }).click();
	await screen
		.getByRole('button', { name: 'Go to Company — Schedule, page 1', exact: true })
		.click();
	await expect.poll(() => pdfLoad(src(DOCUMENT_B))).toBeTypeOf('function');
	const obsoleteLoad = pdfLoad(src(DOCUMENT_B))!;
	const agreement = screen
		.getByRole('navigation', { name: 'Documents' })
		.getByRole('button', { name: 'Agreement', exact: true });
	await agreement.click();
	obsoleteLoad();
	await finish(DOCUMENT_A);
	await expect.poll(() => document.activeElement).toBe(agreement.element());
	await expect
		.element(screen.getByRole('textbox', { name: 'Company — Text' }))
		.not.toBeInTheDocument();
});

test('focuses a missing field on validation and requires explicit final signing confirmation', async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	const screen = await render(SignPage, { data: fixture() });
	await finish(DOCUMENT_A);
	await screen.getByRole('button', { name: 'Sign and complete', exact: true }).click();
	await expect.poll(() => document.activeElement?.id).toBe(FIELD_A);
	await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
	await screen.getByRole('textbox', { name: 'Full name — Text' }).fill('Alex');
	await screen.getByRole('button', { name: 'Next required field' }).click();
	await finish(DOCUMENT_B);
	await screen.getByRole('textbox', { name: 'Company — Text' }).fill('Example Ltd');
	await screen.getByRole('button', { name: 'Sign and complete', exact: true }).click();
	const dialog = screen.getByRole('alertdialog');
	await expect
		.element(dialog.getByRole('heading', { name: 'Complete this agreement?' }))
		.toBeVisible();
	expect(fetchMock).not.toHaveBeenCalled();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect.element(dialog).not.toBeInTheDocument();
	expect(fetchMock).not.toHaveBeenCalled();
});

test('keeps approval separate from signer progress and requires confirmation', async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	const screen = await render(SignPage, { data: fixture('approver') });
	await expect.element(screen.getByRole('progressbar')).not.toBeInTheDocument();
	await expect
		.element(screen.getByRole('button', { name: 'Sign and complete' }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: 'Approve agreement', exact: true }).click();
	const dialog = screen.getByRole('alertdialog');
	await expect.element(dialog).toBeVisible();
	expect(fetchMock).not.toHaveBeenCalled();
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(fetchMock).not.toHaveBeenCalled();
});

test('keeps metadata and actionable progress within a 390px viewport', async () => {
	await page.viewport(390, 844);
	const screen = await render(SignPage, { data: fixture() });
	await expect
		.element(screen.getByRole('heading', { name: 'Service Agreement', level: 1 }))
		.toBeVisible();
	await expect.element(screen.getByText('Link expires', { exact: false })).toBeVisible();
	await expect.element(screen.getByRole('button', { name: 'Next required field' })).toBeVisible();
	expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	await page.screenshot({ fullPage: true });
});
