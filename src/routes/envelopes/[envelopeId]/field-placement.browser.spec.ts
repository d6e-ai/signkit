import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';

vi.mock('$lib/components/pdf-document-view.svelte', async () => ({
	default: (await import('./field-placement-pdf-view-test-stub.svelte')).default
}));

/**
 * Exercises keyboard-only field placement end to end: zero-click creation,
 * fine/coarse move and resize, the percentage FieldSet, deletion, the exact
 * geometry a publish sends, and - because the public field projection omits
 * labels - the read-only treatment and publish/add lockout that protects
 * already-persisted fields from a partial-set replace. Uses a real
 * SignKit-produced one-page PDF so the field overlay renders against an
 * deterministic rendered-page surface. The PDF viewer itself has a separate
 * browser suite, so these placement tests do not repeatedly boot PDF.js.
 */

const { ENVELOPE_ID } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000030'
}));
const READY_AUDIT_ID = '01900000-0000-7000-8000-000000000199';
const SIGNER_ID = '01900000-0000-7000-8000-000000000021';
const DOCUMENT_ID = '01900000-0000-7000-8000-000000000110';
const SECOND_DOCUMENT_ID = '01900000-0000-7000-8000-000000000111';

vi.mock('$app/state', () => ({
	page: {
		url: new URL(`https://signkit.example/envelopes/${ENVELOPE_ID}`),
		params: { envelopeId: ENVELOPE_ID },
		route: { id: '/envelopes/[envelopeId]' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
	if (typeof init?.body !== 'string') return undefined;
	try {
		return JSON.parse(init.body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

const readyEnvelope = {
	id: ENVELOPE_ID,
	title: 'Agreement',
	status: 'ready' as const,
	repositoryGeneration: 1,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:00:00.000Z'
};

const draft = {
	generation: 1,
	commitSha: '0123456789abcdef0123456789abcdef01234567',
	archiveSha256: 'a'.repeat(64),
	documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
	documentSet: {
		schema: 'signkit-document-set-v1',
		documents: [
			{
				id: DOCUMENT_ID,
				position: 0,
				kind: 'markdown' as const,
				title: 'agreement',
				path: 'documents/agreement.md' as const,
				contentSha256: 'a'.repeat(64)
			}
		]
	}
};

const deliveries = {
	delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'ready', deliveries: [] }
};

function detailWith(fields: readonly unknown[]): Record<string, unknown> {
	return {
		envelope: readyEnvelope,
		recipients: [
			{
				id: SIGNER_ID,
				email: 'signer@example.com',
				name: 'Signer',
				role: 'signer',
				locale: 'en',
				routingOrder: 1,
				status: 'pending'
			}
		],
		readyAuditEventId: READY_AUDIT_ID,
		fields
	};
}

function pageMapResponse(documentId = DOCUMENT_ID, multipleDocuments = false): Response {
	const documents = [
		{
			documentId: DOCUMENT_ID,
			position: 0,
			kind: 'markdown',
			title: 'agreement',
			pageCount: 1,
			pageWidth: 595.28,
			pageHeight: 841.89
		}
	];
	if (multipleDocuments) {
		documents.push({
			documentId: SECOND_DOCUMENT_ID,
			position: 1,
			kind: 'pdf',
			title: 'Appendix',
			pageCount: 5,
			pageWidth: 595.28,
			pageHeight: 841.89
		});
	}
	const activeDocument = documents.find((document) => document.documentId === documentId)!;
	return jsonResponse({
		commitSha: readyEnvelope.repositoryHead,
		generation: readyEnvelope.repositoryGeneration,
		documentId,
		pageCount: activeDocument.pageCount,
		pageWidth: 595.28,
		pageHeight: 841.89,
		documents
	});
}

interface MockFetchOptions {
	fields?: readonly unknown[];
	multipleDocuments?: boolean;
	onPlaceFields?: (body: Record<string, unknown> | undefined) => Response;
}

function buildMockFetch(options: MockFetchOptions = {}): ReturnType<typeof vi.fn> {
	return vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
		const urlStr = String(url);
		if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
			return jsonResponse(detailWith(options.fields ?? []));
		}
		if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
			return jsonResponse(draft);
		}
		if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
			return jsonResponse(deliveries);
		}
		if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
			const documentId = new URL(urlStr, 'https://signkit.example').searchParams.get('documentId');
			return pageMapResponse(documentId ?? DOCUMENT_ID, options.multipleDocuments ?? false);
		}
		if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf`)) {
			return new Response(new Uint8Array(), {
				status: 200,
				headers: { 'content-type': 'application/pdf' }
			});
		}
		if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method === 'POST') {
			if (options.onPlaceFields) return options.onPlaceFields(parseBody(init));
			return jsonResponse({
				fields: {
					envelopeId: ENVELOPE_ID,
					generation: 1,
					fieldGeneration: 1,
					commitSha: draft.commitSha,
					fields: [],
					updatedAt: '2026-09-22T00:00:00.000Z',
					auditEventId: '01900000-0000-7000-8000-000000000900'
				}
			});
		}
		return jsonResponse({});
	});
}

function percent(el: Element | null, prop: 'left' | 'top' | 'width' | 'height'): number {
	if (!(el instanceof HTMLElement)) throw new Error('element not found');
	return Number.parseFloat(el.style.getPropertyValue(prop));
}

const DRAFT_BOX_SELECTOR = '[aria-label="Signature for Signer on page 1"]';

async function openFieldsTab(mockFetch: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', mockFetch);
	const screen = await render(EnvelopePage);
	await expect
		.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
		.toBeVisible();
	await screen.getByRole('tab', { name: 'Fields' }).click();
	await expect.element(screen.getByText('Field placement')).toBeVisible();
	return screen;
}

/**
 * Clicks the keyboard "Add field" action and waits for the resulting box to
 * mount (its creation is asynchronous: it awaits a Svelte tick before moving
 * focus) before handing back the raw element for synchronous assertions.
 */
async function addField(screen: Awaited<ReturnType<typeof render>>): Promise<HTMLElement> {
	const addButton = screen.getByRole('button', { name: 'Add field' });
	(addButton.element() as HTMLButtonElement).focus();
	await userEvent.keyboard('{Enter}');
	const locator = screen.getByRole('button', { name: 'Signature for Signer on page 1' });
	await expect.element(locator).toBeVisible();
	return locator.element() as HTMLElement;
}

describe('keyboard field placement', () => {
	it('creates a field with zero clicks at a deterministic, non-central position and focuses it', async () => {
		const mockFetch = buildMockFetch();
		const screen = await openFieldsTab(mockFetch);

		const box = await addField(screen);
		expect(box.tagName).toBe('BUTTON');
		expect(box?.getAttribute('aria-pressed')).toBe('true');
		// Deterministic, bounded inset - not centered (50%/50%) on the page.
		expect(percent(box, 'left')).toBeCloseTo(8, 5);
		expect(percent(box, 'top')).toBeCloseTo(8, 5);
		expect(percent(box, 'width')).toBeCloseTo(26, 5);
		expect(percent(box, 'height')).toBeCloseTo(5, 5);
		// A visible focus ring class and real focus, not just visual selection.
		expect(box?.className).toMatch(/focus-visible:ring-2/);
		expect(document.activeElement).toBe(box);

		// aria-live geometry summary announces the freshly created box.
		const status = screen.container.querySelector('[role="status"][aria-live="polite"]');
		expect(status?.textContent).toContain('8%');
	});

	it('moves the focused field with fine (0.5%) and coarse (Shift, 2.5%) arrow steps', async () => {
		const mockFetch = buildMockFetch();
		const screen = await openFieldsTab(mockFetch);
		const box = await addField(screen);
		expect(document.activeElement).toBe(box);

		await userEvent.keyboard('{ArrowRight}');
		expect(percent(box, 'left')).toBeCloseTo(8.5, 5);
		const status = screen.container.querySelector('[role="status"][aria-live="polite"]');
		expect(status?.textContent).toContain('8.5%');

		await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
		expect(percent(box, 'left')).toBeCloseTo(11, 5);

		await userEvent.keyboard('{ArrowDown}');
		expect(percent(box, 'top')).toBeCloseTo(8.5, 5);

		await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
		expect(percent(box, 'top')).toBeCloseTo(11, 5);
	});

	it('resizes the focused field with Alt (fine) and Alt+Shift (coarse) arrow steps, clamped to a minimum size', async () => {
		const mockFetch = buildMockFetch();
		const screen = await openFieldsTab(mockFetch);
		const box = await addField(screen);

		await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
		expect(percent(box, 'width')).toBeCloseTo(26.5, 5);

		await userEvent.keyboard('{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}');
		expect(percent(box, 'width')).toBeCloseTo(29, 5);

		// Height starts at 5%; two coarse shrinks would go past the 2% floor.
		await userEvent.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}');
		expect(percent(box, 'height')).toBeCloseTo(2.5, 5);
		await userEvent.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}');
		expect(percent(box, 'height')).toBeCloseTo(2, 5);
	});

	it('edits geometry through the Page/Left/Top/Width/Height percentage FieldSet, sharing the same clamp', async () => {
		const mockFetch = buildMockFetch();
		const screen = await openFieldsTab(mockFetch);
		const box = await addField(screen);

		const widthInput = screen.container.querySelector('#selected-field-width') as HTMLInputElement;
		const leftInput = screen.container.querySelector('#selected-field-left') as HTMLInputElement;
		expect(widthInput).not.toBeNull();
		expect(leftInput).not.toBeNull();
		expect(Number(widthInput.value)).toBeCloseTo(26, 5);
		expect(Number(leftInput.value)).toBeCloseTo(8, 5);

		await screen.getByLabelText('Left').fill('40');
		await expect.poll(() => percent(box, 'left')).toBeCloseTo(40, 5);

		// Below the minimum size clamps back up rather than producing a degenerate box.
		await screen.getByLabelText('Width').fill('0');
		await expect.poll(() => percent(box, 'width')).toBeGreaterThanOrEqual(2);
	});

	it('removes the focused field with Delete or Backspace', async () => {
		const mockFetch = buildMockFetch();
		const screen = await openFieldsTab(mockFetch);
		await addField(screen);
		expect(screen.container.querySelector(DRAFT_BOX_SELECTOR)).not.toBeNull();

		await userEvent.keyboard('{Delete}');
		expect(screen.container.querySelector(DRAFT_BOX_SELECTOR)).toBeNull();

		await addField(screen);
		expect(screen.container.querySelector(DRAFT_BOX_SELECTOR)).not.toBeNull();
		await userEvent.keyboard('{Backspace}');
		expect(screen.container.querySelector(DRAFT_BOX_SELECTOR)).toBeNull();
	});

	it('clears the selected field when switching documents so the wrong page bounds cannot edit it', async () => {
		const mockFetch = buildMockFetch({ multipleDocuments: true });
		const screen = await openFieldsTab(mockFetch);
		await addField(screen);
		expect(screen.container.querySelector('#selected-field-page')).not.toBeNull();

		await screen.getByRole('button', { name: /Appendix/ }).click();
		await expect.poll(() => screen.container.querySelector('#selected-field-page')).toBeNull();
	});

	it('publishes the exact clamped geometry shown on screen', async () => {
		let publishedBody: Record<string, unknown> | undefined;
		const mockFetch = buildMockFetch({
			onPlaceFields: (body) => {
				publishedBody = body;
				return jsonResponse({
					fields: {
						envelopeId: ENVELOPE_ID,
						generation: 1,
						fieldGeneration: 1,
						commitSha: draft.commitSha,
						fields: [
							{
								id: '01900000-0000-7000-8000-000000000500',
								recipientId: SIGNER_ID,
								documentId: DOCUMENT_ID,
								documentPath: 'documents/agreement.md',
								fieldType: 'signature',
								required: true,
								position: 1,
								geometry: { page: 1, x: 0.085, y: 0.08, width: 0.26, height: 0.05 }
							}
						],
						updatedAt: '2026-09-22T00:00:00.000Z',
						auditEventId: '01900000-0000-7000-8000-000000000901'
					}
				});
			}
		});
		const screen = await openFieldsTab(mockFetch);
		await addField(screen);
		await userEvent.keyboard('{ArrowRight}');

		await screen.getByRole('button', { name: 'Publish field set' }).click();
		await expect.element(screen.getByText('1 fields published.')).toBeVisible();

		expect(publishedBody).toBeDefined();
		expect(publishedBody?.expectedGeneration).toBe(1);
		expect(publishedBody?.expectedFieldGeneration).toBe(0);
		const fields = publishedBody?.fields as readonly Record<string, unknown>[];
		expect(fields).toHaveLength(1);
		expect(fields[0].recipientId).toBe(SIGNER_ID);
		expect(fields[0].documentId).toBe(DOCUMENT_ID);
		expect(fields[0].fieldType).toBe('signature');
		expect(fields[0].required).toBe(true);
		expect(fields[0].position).toBe(1);
		const geometry = fields[0].geometry as Record<string, number>;
		expect(geometry.page).toBe(1);
		expect(geometry.x).toBeCloseTo(0.085, 6);
		expect(geometry.y).toBeCloseTo(0.08, 6);
		expect(geometry.width).toBeCloseTo(0.26, 6);
		expect(geometry.height).toBeCloseTo(0.05, 6);
	});
});

describe('published fields protect against partial-replacement data loss', () => {
	const publishedField = {
		id: '01900000-0000-7000-8000-000000000600',
		recipientId: SIGNER_ID,
		documentId: DOCUMENT_ID,
		documentPath: 'documents/agreement.md',
		fieldType: 'signature',
		required: true,
		position: 1,
		geometry: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.06 }
	};

	it('renders persisted fields at their exact stored geometry, keyboard selectable after remount, read-only, and blocks new/partial placement', async () => {
		const mockFetch = buildMockFetch({ fields: [publishedField] });
		vi.stubGlobal('fetch', mockFetch);

		const first = await render(EnvelopePage);
		await expect
			.element(first.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		first.unmount();

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Fields' }).click();

		// Locked notice explains why, in place of the recipient/type creation form.
		await expect.element(screen.getByText(/already has published fields/i)).toBeVisible();
		expect(screen.container.querySelector('#field-recipient')).toBeNull();
		expect(screen.container.querySelector('#field-add-page')).toBeNull();
		expect(screen.container.textContent).not.toContain('Publish field set');

		// Exact persisted geometry, rendered as a real focusable button.
		const box = screen.container.querySelector(
			'[aria-label="Signature for Signer on page 1"]'
		) as HTMLElement | null;
		expect(box).not.toBeNull();
		expect(box?.tagName).toBe('BUTTON');
		expect(percent(box, 'left')).toBeCloseTo(10, 5);
		expect(percent(box, 'top')).toBeCloseTo(20, 5);
		expect(percent(box, 'width')).toBeCloseTo(30, 5);
		expect(percent(box, 'height')).toBeCloseTo(6, 5);
		// No pointer-drag resize handle on a read-only box.
		expect(box?.querySelector('[role="presentation"]')).toBeNull();

		box?.focus();
		expect(document.activeElement).toBe(box);
		await userEvent.keyboard('{Enter}');
		await expect.poll(() => box?.getAttribute('aria-pressed')).toBe('true');

		// The geometry FieldSet mirrors the exact stored value but is read-only -
		// not disabled, so it stays reachable by Tab and readable by a screen reader.
		const pageInput = screen.container.querySelector('#selected-field-page') as HTMLInputElement;
		const leftInput = screen.container.querySelector('#selected-field-left') as HTMLInputElement;
		expect(pageInput.readOnly).toBe(true);
		expect(leftInput.readOnly).toBe(true);
		expect(Number(leftInput.value)).toBeCloseTo(10, 5);
		await expect.element(screen.getByText(/already published and can't be edited/i)).toBeVisible();

		// Read-only: arrow keys on the focused, selected box do not mutate it.
		await userEvent.keyboard('{ArrowRight}');
		expect(percent(box, 'left')).toBeCloseTo(10, 5);

		// No POST to /fields is ever issued - there is no UI path left to trigger one.
		expect(
			mockFetch.mock.calls.some(
				(call: unknown[]) =>
					String(call[0]).includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) &&
					(call[1] as RequestInit | undefined)?.method === 'POST'
			)
		).toBe(false);
	});
});
