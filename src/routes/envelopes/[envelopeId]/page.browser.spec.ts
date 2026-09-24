import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';

const { ENVELOPE_ID } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000020'
}));
const READY_AUDIT_ID = '01900000-0000-7000-8000-000000000099';
const SIGNER_ID = '01900000-0000-7000-8000-000000000011';
const NAME_REQUIRED_MESSAGE = "Enter this recipient's name.";
const EMAIL_INVALID_MESSAGE = 'Enter a valid email address for this recipient.';

// The Fields tab's own placement gating and the Documents tab's sent-PDF
// rendering are exercised here through this stand-in rather than the real
// PdfDocumentView, so these tests do not each boot pdf.js: the component's
// loading/error/canvas behavior has its own browser suite
// (pdf-document-view.browser.spec.ts).
vi.mock('$lib/components/pdf-document-view.svelte', async () => ({
	default: (await import('./sent-document-pdf-view-test-stub.svelte')).default
}));

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

const DOCUMENT_ID = '01900000-0000-7000-8000-000000000010';

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

const detail = {
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
	fields: []
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

function pageMapResponse(overrides: Record<string, unknown> = {}): Response {
	return jsonResponse({
		commitSha: readyEnvelope.repositoryHead,
		generation: readyEnvelope.repositoryGeneration,
		documentId: DOCUMENT_ID,
		pageCount: 1,
		pageWidth: 595.28,
		pageHeight: 841.89,
		documents: [
			{
				documentId: DOCUMENT_ID,
				position: 0,
				kind: 'markdown',
				title: 'agreement',
				pageCount: 1,
				pageWidth: 595.28,
				pageHeight: 841.89
			}
		],
		...overrides
	});
}

const deliveries = {
	delivery: {
		envelopeId: ENVELOPE_ID,
		envelopeStatus: 'ready',
		deliveries: []
	}
};

function parseBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
	if (typeof init?.body !== 'string') return undefined;
	try {
		return JSON.parse(init.body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

describe('envelope authoring page remounts durable send state', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('reloads detail after unmount and recovers expectedReadyAuditEventId on send', async () => {
		let sendBody: Record<string, unknown> | undefined;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse(detail);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(deliveries);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/send`) && init?.method === 'POST') {
					sendBody = parseBody(init);
					return jsonResponse({
						sent: {
							envelopeId: ENVELOPE_ID,
							status: 'sent',
							generation: 1,
							commitSha: draft.commitSha,
							readyAuditEventId: READY_AUDIT_ID,
							queuedDeliveryCount: 1,
							reservedCapabilityCount: 1,
							initialCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
							updatedAt: '2026-09-13T00:00:00.000Z',
							auditEventId: '01900000-0000-7000-8000-000000000088'
						}
					});
				}
				return jsonResponse({});
			});
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
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		await expect.element(screen.getByRole('button', { name: 'Send envelope' })).toBeVisible();
		await screen.getByRole('button', { name: 'Send envelope' }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: 'Send envelope' }).click();

		expect(sendBody).toEqual({
			expectedGeneration: 1,
			expectedReadyAuditEventId: READY_AUDIT_ID
		});
	});

	it('shows each recipient language, localized role, and workflow status in the immutable post-ready table', async () => {
		const jaRecipientId = '01900000-0000-7000-8000-000000000012';
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						...detail,
						recipients: [
							{
								id: SIGNER_ID,
								email: 'alice@example.com',
								name: 'Alice Chen',
								role: 'signer',
								locale: 'en',
								routingOrder: 1,
								status: 'pending'
							},
							{
								id: jaRecipientId,
								email: 'sato@example.com',
								name: '佐藤',
								role: 'approver',
								locale: 'ja',
								routingOrder: 2,
								status: 'viewed'
							}
						]
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(deliveries);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect.element(screen.getByText('Revision 1')).toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		const recipientsPanel = screen.getByRole('tabpanel', { name: 'Recipients' });
		await expect.element(recipientsPanel.getByText('Language')).toBeVisible();
		await expect.element(recipientsPanel.getByText('English')).toBeVisible();
		await expect.element(recipientsPanel.getByText('日本語')).toBeVisible();
		await expect.element(recipientsPanel.getByRole('cell', { name: 'Alice Chen' })).toBeVisible();
		await expect.element(recipientsPanel.getByRole('cell', { name: 'Signer' })).toBeVisible();
		await expect.element(recipientsPanel.getByRole('cell', { name: 'Approver' })).toBeVisible();
		await expect.element(recipientsPanel.getByRole('cell', { name: 'Waiting' })).toBeVisible();
		await expect.element(recipientsPanel.getByRole('cell', { name: 'Viewed' })).toBeVisible();
		expect(recipientsPanel.element().textContent).not.toContain('signer');
		expect(recipientsPanel.element().textContent).not.toContain('pending');
		expect(recipientsPanel.element().textContent).not.toContain('Routing order');
		expect(screen.container.textContent).not.toContain('Git generation');
	});

	it('lets operators choose recipient role and language with shadcn selects', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		const languageSelect = screen.getByLabelText('Language');
		await expect.element(screen.getByLabelText('Role')).toBeVisible();
		await expect.element(screen.getByRole('cell', { name: 'Order' })).toBeVisible();
		await expect.element(languageSelect).toBeVisible();
		await expect.element(languageSelect).toHaveTextContent('English');
		await languageSelect.click();
		await expect.element(screen.getByRole('option', { name: '日本語' })).toBeVisible();
		await screen.getByRole('option', { name: '日本語' }).click();
		await expect.element(languageSelect).toHaveTextContent('日本語');
	});

	it('creates a new contact after editing identity fields copied from an existing contact', async () => {
		const contact = {
			id: '01900000-0000-7000-8000-000000000050',
			name: 'Alice Example',
			email: 'alice@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const createdContact = {
			...contact,
			id: '01900000-0000-7000-8000-000000000051',
			name: 'Alice Copy'
		};
		const contactMutations: Array<{ method: string; url: string; body: unknown }> = [];
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.startsWith('/api/v1/contacts?')) {
					return jsonResponse({ items: [contact], nextCursor: null });
				}
				if (
					urlStr.startsWith('/api/v1/contacts') &&
					(init?.method === 'POST' || init?.method === 'PUT')
				) {
					const body = parseBody(init);
					contactMutations.push({ method: init.method, url: urlStr, body });
					return jsonResponse(
						{
							contact: {
								...createdContact,
								...(body ?? {}),
								id:
									contactMutations.length === 1
										? createdContact.id
										: '01900000-0000-7000-8000-000000000052'
							}
						},
						201
					);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByRole('combobox', { name: 'Choose contact' }).click();
		await expect.element(screen.getByText('Alice Example')).toBeVisible();
		await screen.getByText('Alice Example').click();
		await screen.getByLabelText('Name').fill('Alice Copy');
		await screen.getByLabelText('Email').fill('alice.copy@example.com');
		await screen.getByRole('button', { name: 'Save to contacts' }).click();
		await expect.element(screen.getByRole('button', { name: 'Saved to contacts' })).toBeVisible();
		await screen.getByLabelText('Name').fill('Alice Another');
		await screen.getByLabelText('Email').fill('alice.another@example.com');
		await screen.getByRole('button', { name: 'Save to contacts' }).click();
		await expect.element(screen.getByRole('button', { name: 'Saved to contacts' })).toBeVisible();

		expect(contactMutations).toEqual([
			{
				method: 'POST',
				url: '/api/v1/contacts',
				body: { name: 'Alice Copy', email: 'alice.copy@example.com', locale: 'en' }
			},
			{
				method: 'POST',
				url: '/api/v1/contacts',
				body: { name: 'Alice Another', email: 'alice.another@example.com', locale: 'en' }
			}
		]);
	});

	it('opens one document picker with PDF and Word choices', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		expect(screen.container.textContent).not.toContain('New document name');
		await screen.getByRole('button', { name: 'Add document' }).click();
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('heading', { name: 'Add a document' })).toBeVisible();
		await expect.element(dialog.getByText('Upload PDF')).toBeVisible();
		await expect.element(dialog.getByText('Upload Word document')).toBeVisible();
	});

	it('joins delivery rows to recipients and shows invitation state, not workflow enums', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						...detail,
						envelope: { ...readyEnvelope, status: 'sent' },
						recipients: [
							{
								id: SIGNER_ID,
								email: 'alice@example.com',
								name: 'Alice Chen',
								role: 'signer',
								locale: 'en',
								routingOrder: 1,
								status: 'pending'
							}
						]
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse({
						delivery: {
							envelopeId: ENVELOPE_ID,
							envelopeStatus: 'sent',
							deliveries: [
								{
									recipientId: SIGNER_ID,
									recipientRole: 'signer',
									routingOrder: 1,
									status: 'pending',
									attempts: 3,
									availableAt: '2026-09-12T00:00:00.000Z',
									deliveredAt: null,
									updatedAt: '2026-09-12T00:00:00.000Z',
									errorCode: null
								},
								{
									recipientId: '01900000-0000-7000-8000-000000000013',
									recipientRole: 'approver',
									routingOrder: 2,
									status: 'blocked',
									attempts: 0,
									availableAt: null,
									deliveredAt: null,
									updatedAt: '2026-09-12T00:00:00.000Z',
									errorCode: null
								}
							]
						}
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		const sendPanel = screen.getByRole('tabpanel', { name: 'Send & status' });
		await expect.element(sendPanel.getByText('Alice Chen')).toBeVisible();
		await expect.element(sendPanel.getByText('alice@example.com')).toBeVisible();
		await expect.element(sendPanel.getByText('Waiting to send')).toBeVisible();
		await expect.element(sendPanel.getByText('Waiting for earlier recipients')).toBeVisible();
		await expect.element(sendPanel.getByRole('cell', { name: 'Signer' })).toBeVisible();
		expect(sendPanel.element().textContent).not.toContain('Routing order');
		expect(sendPanel.element().textContent).not.toContain('Attempts');
		expect(sendPanel.element().textContent).not.toMatch(/\bpending\b/);
		expect(sendPanel.element().textContent).not.toMatch(/\bsigner\b/);
	});

	it('does not render field placement until pages match the current ready revision', async () => {
		let releasePages: (value: Response) => void = (): void => undefined;
		const pagesResponse: Promise<Response> = new Promise((resolve) => {
			releasePages = resolve;
		});
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse(detail);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(deliveries);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
					return pagesResponse;
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf`)) {
					return new Response(new Uint8Array(), {
						status: 200,
						headers: { 'content-type': 'application/pdf' }
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Fields' }).click();
		expect(screen.container.textContent).not.toContain('Field placement');

		releasePages(pageMapResponse());

		await expect.element(screen.getByText('Field placement')).toBeVisible();
	});

	it('rejects a stale page map so placement stays gated off', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse(detail);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(deliveries);
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
					return pageMapResponse({
						commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
						generation: 0
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Fields' }).click();
		await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
		expect(screen.container.textContent).not.toContain('Field placement');
	});

	it('does not fetch a page map while the envelope is still draft', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		expect(
			mockFetch.mock.calls.some((call) => String(call[0]).includes('/document-pdf/pages'))
		).toBe(false);
	});

	it('keeps Mark ready disabled and shows an inline error for a blank recipient name (mouse)', async () => {
		let readyCalled = false;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/ready`)) {
					readyCalled = true;
					return jsonResponse({});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByLabelText('Email').fill('signer@example.com');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();
		expect(screen.container.textContent).not.toContain(NAME_REQUIRED_MESSAGE);

		// Leaving the still-blank name field shows the inline error.
		await screen.getByLabelText('Name').click();
		await screen.getByLabelText('Email').click();
		await expect.element(screen.getByText(NAME_REQUIRED_MESSAGE)).toBeVisible();
		await expect.element(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();

		// A whitespace-only name is treated the same as blank.
		await screen.getByLabelText('Name').fill('   ');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();

		await screen.getByLabelText('Name').fill('Signer Example');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
		expect(screen.container.textContent).not.toContain(NAME_REQUIRED_MESSAGE);
		expect(readyCalled).toBe(false);
	});

	it('keeps Mark ready disabled and shows an inline error for a blank or malformed recipient email (mouse)', async () => {
		let readyCalled = false;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/ready`)) {
					readyCalled = true;
					return jsonResponse({});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByLabelText('Name').fill('Signer Example');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();
		expect(screen.container.textContent).not.toContain(EMAIL_INVALID_MESSAGE);

		// Leaving the still-blank email field shows the inline error.
		await screen.getByLabelText('Email').click();
		await screen.getByLabelText('Name').click();
		await expect.element(screen.getByText(EMAIL_INVALID_MESSAGE)).toBeVisible();
		await expect.element(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();

		// A malformed address is rejected by the same predicate the server uses.
		await screen.getByLabelText('Email').fill('not-an-email');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();
		await expect.element(screen.getByText(EMAIL_INVALID_MESSAGE)).toBeVisible();

		// Structurally malformed domains must not pass the client while the API rejects them.
		await screen.getByLabelText('Email').fill('signer@example..com');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();
		await expect.element(screen.getByText(EMAIL_INVALID_MESSAGE)).toBeVisible();

		// A whitespace-only email is treated the same as blank.
		await screen.getByLabelText('Email').fill('   ');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeDisabled();

		await screen.getByLabelText('Email').fill('signer@example.com');
		await expect.element(screen.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
		expect(screen.container.textContent).not.toContain(EMAIL_INVALID_MESSAGE);
		expect(readyCalled).toBe(false);
	});

	it('orders keyboard focus by row and column - email before name - and never submits early (keyboard)', async () => {
		let readyCalled = false;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse({
						envelope: { ...readyEnvelope, status: 'draft' },
						recipients: [],
						readyAuditEventId: null,
						fields: []
					});
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return jsonResponse(draft);
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/ready`)) {
					readyCalled = true;
					return jsonResponse({
						ready: { recipients: [], auditEventId: READY_AUDIT_ID }
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		const emailInput = screen.getByLabelText('Email');
		const nameInput = screen.getByLabelText('Name');

		// Both fields are blank. Pressing Enter from the name field still moves
		// focus to email, since it is the first invalid field in column order,
		// not just a re-check of whichever field currently has focus.
		await nameInput.click();
		await userEvent.keyboard('{Enter}');
		await expect.element(emailInput).toHaveFocus();
		await expect.element(screen.getByText(EMAIL_INVALID_MESSAGE)).toBeVisible();
		expect(readyCalled).toBe(false);

		await emailInput.fill('not-an-email');
		await userEvent.keyboard('{Enter}');
		await expect.element(emailInput).toHaveFocus();
		expect(readyCalled).toBe(false);

		await emailInput.fill('signer@example.com');
		await userEvent.keyboard('{Enter}');
		await expect.element(nameInput).toHaveFocus();
		await expect.element(screen.getByText(NAME_REQUIRED_MESSAGE)).toBeVisible();
		expect(readyCalled).toBe(false);

		await nameInput.fill('Signer Example');
		await userEvent.keyboard('{Enter}');
		expect(readyCalled).toBe(true);
	});
});

describe('completed envelope shows the completed-artifacts card', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const completedEnvelope = {
		...readyEnvelope,
		status: 'completed' as const,
		sentCommitSha: '0123456789abcdef0123456789abcdef01234567'
	};

	const completedDetail = { ...detail, envelope: completedEnvelope };

	function mockCompletedFetch(
		completionArtifactResponse: () => Response,
		extraRoutes: (urlStr: string, init: RequestInit | undefined) => Response | undefined = () =>
			undefined
	) {
		return vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			const extra = extraRoutes(urlStr, init);
			if (extra) return extra;
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse(completedDetail);
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return new Response(null, { status: 404 });
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse(deliveries);
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`)) {
				return completionArtifactResponse();
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method !== 'POST') {
				return jsonResponse({
					pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' }
				});
			}
			return jsonResponse({});
		});
	}

	it('published: offers final PDF and evidence downloads once the PDF has published', async () => {
		const mockFetch = mockCompletedFetch(() =>
			jsonResponse({
				completionArtifact: {
					envelopeId: ENVELOPE_ID,
					status: 'published',
					publishedAt: '2026-09-12T00:00:00.000Z',
					manifestSha256: 'm'.repeat(64),
					jsonSha256: 'j'.repeat(64),
					markdownSha256: 'd'.repeat(64),
					pdfStatus: 'published'
				}
			})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Download final PDF' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Download evidence (JSON)' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Download evidence (Markdown)' }))
			.toBeVisible();
	});

	it('pending: notes that the final PDF is still being prepared, but evidence stays downloadable', async () => {
		const mockFetch = mockCompletedFetch(() =>
			jsonResponse({
				completionArtifact: {
					envelopeId: ENVELOPE_ID,
					status: 'published',
					publishedAt: '2026-09-12T00:00:00.000Z',
					manifestSha256: 'm'.repeat(64),
					jsonSha256: 'j'.repeat(64),
					markdownSha256: 'd'.repeat(64),
					pdfStatus: 'pending'
				}
			})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect.element(screen.getByText('The final PDF is still being prepared.')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Download final PDF' }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Download evidence (JSON)' }))
			.toBeVisible();
	});

	it('failed: explains that completion evidence could not be generated', async () => {
		const mockFetch = mockCompletedFetch(() =>
			jsonResponse({
				completionArtifact: {
					envelopeId: ENVELOPE_ID,
					status: 'failed',
					attempts: 10,
					errorCode: 'completion_artifact_attempts_exhausted',
					availableAt: null
				}
			})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect
			.element(
				screen.getByText(
					'Completion evidence could not be generated. Contact support if this continues.'
				)
			)
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Download final PDF' }))
			.not.toBeInTheDocument();
	});

	it('unavailable: reports the status could not be loaded when the read fails', async () => {
		const mockFetch = mockCompletedFetch(
			() =>
				new Response(JSON.stringify({ status: 503 }), {
					status: 503,
					headers: { 'content-type': 'application/problem+json' }
				})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect
			.element(screen.getByText('Completion status could not be loaded. Please try again shortly.'))
			.toBeVisible();
	});

	it('keeps visual completion distinct from unavailable certificate-backed instance sealing', async () => {
		const mockFetch = mockCompletedFetch(() =>
			jsonResponse({
				completionArtifact: {
					envelopeId: ENVELOPE_ID,
					status: 'published',
					publishedAt: '2026-09-12T00:00:00.000Z',
					manifestSha256: 'm'.repeat(64),
					jsonSha256: 'j'.repeat(64),
					markdownSha256: 'd'.repeat(64),
					pdfStatus: 'published'
				}
			})
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(
				screen.getByText(
					'An optional certificate-backed instance signature over the final PDF. This is separate from the visual completion document above.'
				)
			)
			.toBeVisible();
		await expect
			.element(
				screen.getByText('PDF instance sealing is not configured for this SignKit instance.')
			)
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Request PDF instance seal' }))
			.not.toBeInTheDocument();
	});

	it('does not offer an instance seal until the completion PDF is published', async () => {
		const mockFetch = mockCompletedFetch(
			() =>
				jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'published',
						publishedAt: '2026-09-12T00:00:00.000Z',
						manifestSha256: 'm'.repeat(64),
						jsonSha256: 'j'.repeat(64),
						markdownSha256: 'd'.repeat(64),
						pdfStatus: 'pending'
					}
				}),
			(urlStr, init) =>
				urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method !== 'POST'
					? jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'not_requested' } })
					: undefined
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByText('The final PDF is still being prepared.').last())
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Request PDF instance seal' }))
			.not.toBeInTheDocument();
		expect(
			mockFetch.mock.calls.some(
				([url, init]) =>
					String(url).endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) &&
					init?.method === 'POST'
			)
		).toBe(false);
	});

	it('reports completion processing instead of claiming the source PDF is unavailable', async () => {
		const mockFetch = mockCompletedFetch(
			() =>
				jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'processing',
						attempts: 1
					}
				}),
			(urlStr, init) =>
				urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method !== 'POST'
					? jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'not_requested' } })
					: undefined
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(
				screen
					.getByText('Completion evidence is being prepared. This can take a few minutes.')
					.last()
			)
			.toBeVisible();
		await expect
			.element(screen.getByText('A final PDF is not available for this agreement.'))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('button', { name: 'Request PDF instance seal' }))
			.not.toBeInTheDocument();
	});

	it('submits an explicit B-T instance-seal request only from the not-requested state', async () => {
		let requestBody: Record<string, unknown> | undefined;
		const mockFetch = mockCompletedFetch(
			() =>
				jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'published',
						publishedAt: '2026-09-12T00:00:00.000Z',
						manifestSha256: 'm'.repeat(64),
						jsonSha256: 'j'.repeat(64),
						markdownSha256: 'd'.repeat(64),
						pdfStatus: 'published'
					}
				}),
			(urlStr, init) => {
				if (!urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`)) return undefined;
				if (init?.method === 'POST') {
					requestBody = parseBody(init);
					return jsonResponse(
						{
							pdfSeal: {
								envelopeId: ENVELOPE_ID,
								jobId: '01900000-0000-7000-8000-000000000088',
								requestedProfile: 'pades-b-t',
								requestedAt: '2026-09-23T00:00:00.000Z'
							}
						},
						202
					);
				}
				return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'not_requested' } });
			}
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(
				screen.getByText('Certificate-backed PDF signature with an RFC 3161 trusted timestamp.')
			)
			.toBeVisible();
		await screen.getByRole('button', { name: 'Request PDF instance seal' }).click();
		await vi.waitFor(() => expect(requestBody).toEqual({ requestedProfile: 'pades-b-t' }));
		const post = mockFetch.mock.calls.find(
			([url, init]) =>
				String(url).endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method === 'POST'
		);
		expect((post?.[1]?.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
	});

	it('shows independently validated B-T publication and enables only the sealed download', async () => {
		const mockFetch = mockCompletedFetch(
			() =>
				jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'published',
						publishedAt: '2026-09-12T00:00:00.000Z',
						manifestSha256: 'm'.repeat(64),
						jsonSha256: 'j'.repeat(64),
						markdownSha256: 'd'.repeat(64),
						pdfStatus: 'published'
					}
				}),
			(urlStr, init) => {
				if (
					urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) &&
					init?.method !== 'POST'
				) {
					return jsonResponse({
						pdfSeal: {
							envelopeId: ENVELOPE_ID,
							status: 'published',
							requestedProfile: 'pades-b-t',
							achievedProfile: 'pades-b-t',
							signerCertificateSha256: 'c'.repeat(64),
							sealedSha256: 's'.repeat(64),
							sealedByteSize: 1024,
							validationReportSha256: 'v'.repeat(64),
							validatedAt: '2026-09-23T00:01:00.000Z',
							publishedAt: '2026-09-23T00:02:00.000Z'
						}
					});
				}
				return undefined;
			}
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByText('Independently validated', { exact: true }))
			.toBeVisible();
		await expect.element(screen.getByText('Trusted timestamp validated')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Download sealed PDF' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Request PDF instance seal' }))
			.not.toBeInTheDocument();
	});

	it('shows retry semantics for a failed instance seal without offering a sealed download', async () => {
		const mockFetch = mockCompletedFetch(
			() =>
				jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'published',
						publishedAt: '2026-09-12T00:00:00.000Z',
						manifestSha256: 'm'.repeat(64),
						jsonSha256: 'j'.repeat(64),
						markdownSha256: 'd'.repeat(64),
						pdfStatus: 'published'
					}
				}),
			(urlStr, init) =>
				urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method !== 'POST'
					? jsonResponse({
							pdfSeal: {
								envelopeId: ENVELOPE_ID,
								status: 'failed',
								requestedProfile: 'pades-b-b',
								attempts: 2,
								retryable: true,
								errorCode: 'provider_timeout',
								requestedAt: '2026-09-23T00:00:00.000Z'
							}
						})
					: undefined
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByText('SignKit will retry this request. Refresh to check its status.'))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Refresh instance seal status' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Download sealed PDF' }))
			.not.toBeInTheDocument();
	});
});

describe('sent envelope Documents tab renders the pinned document set', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const PDF_DOCUMENT_ID = '01900000-0000-7000-8000-000000000210';
	const MARKDOWN_DOCUMENT_ID = '01900000-0000-7000-8000-000000000211';

	const sentEnvelope = {
		...readyEnvelope,
		status: 'sent' as const,
		sentCommitSha: readyEnvelope.repositoryHead
	};

	const sentDetail = { ...detail, envelope: sentEnvelope };

	const pdfLeaf = {
		id: PDF_DOCUMENT_ID,
		position: 0,
		kind: 'pdf' as const,
		title: 'signkit-sample-agreement-ja',
		sha256: 'b'.repeat(64),
		byteSize: 12345,
		pageCount: 3,
		pageWidth: 595.28,
		pageHeight: 841.89
	};

	const markdownLeaf = {
		id: MARKDOWN_DOCUMENT_ID,
		position: 0,
		kind: 'markdown' as const,
		title: 'cover letter',
		path: 'documents/cover-letter.md' as const,
		contentSha256: 'a'.repeat(64)
	};

	const pdfOnlyDraft = {
		generation: 1,
		commitSha: sentEnvelope.repositoryHead,
		archiveSha256: 'a'.repeat(64),
		documents: [],
		documentSet: { schema: 'signkit-document-set-v1', documents: [pdfLeaf] }
	};

	const mixedDraft = {
		generation: 1,
		commitSha: sentEnvelope.repositoryHead,
		archiveSha256: 'a'.repeat(64),
		documents: [{ path: 'documents/cover-letter.md', content: '# Terms\n\nSee attached.' }],
		documentSet: {
			schema: 'signkit-document-set-v1',
			documents: [markdownLeaf, { ...pdfLeaf, position: 1 }]
		}
	};

	function mockSentFetch(
		workspace: unknown,
		envelope: unknown = sentEnvelope
	): ReturnType<typeof vi.fn> {
		return vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({ ...sentDetail, envelope });
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(workspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse(deliveries);
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`)) {
				return jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'published',
						publishedAt: '2026-09-12T00:00:00.000Z',
						manifestSha256: 'm'.repeat(64),
						jsonSha256: 'j'.repeat(64),
						markdownSha256: 'd'.repeat(64),
						pdfStatus: 'published'
					}
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`) && init?.method !== 'POST') {
				return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' } });
			}
			return jsonResponse({});
		});
	}

	it("shows a PDF-only sent envelope's document with its title and page count", async () => {
		vi.stubGlobal('fetch', mockSentFetch(pdfOnlyDraft));

		const screen = await render(EnvelopePage);
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
		await expect.element(documentsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect.element(documentsPanel.getByText('Pages: 3')).toBeVisible();
		const stub = documentsPanel.getByTestId('sent-document-pdf-stub');
		await expect.element(stub).toBeInTheDocument();
		expect(stub.element().getAttribute('data-src')).toBe(
			`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf?documentId=${PDF_DOCUMENT_ID}`
		);
		expect(stub.element().getAttribute('data-page-count')).toBe('3');
		expect(documentsPanel.element().textContent).not.toContain('Add document');
	});

	it('shows both the Markdown document and the PDF document for a mixed sent envelope', async () => {
		vi.stubGlobal('fetch', mockSentFetch(mixedDraft));

		const screen = await render(EnvelopePage);
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
		await expect.element(documentsPanel.getByText('cover letter')).toBeVisible();
		await expect.element(documentsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect.element(documentsPanel.getByText('See attached.')).toBeVisible();
	});

	it('keeps showing the sent PDF document after the page is unmounted and remounted', async () => {
		vi.stubGlobal('fetch', mockSentFetch(pdfOnlyDraft));

		const first = await render(EnvelopePage);
		await expect
			.element(
				first.getByRole('tabpanel', { name: 'Documents' }).getByText('signkit-sample-agreement-ja')
			)
			.toBeVisible();
		first.unmount();

		const screen = await render(EnvelopePage);
		await expect
			.element(
				screen.getByRole('tabpanel', { name: 'Documents' }).getByText('signkit-sample-agreement-ja')
			)
			.toBeVisible();
	});

	it('still shows the original sent PDF for a completed envelope, distinct from the completed-artifacts card', async () => {
		vi.stubGlobal(
			'fetch',
			mockSentFetch(pdfOnlyDraft, { ...sentEnvelope, status: 'completed' as const })
		);

		const screen = await render(EnvelopePage);
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
		await expect.element(documentsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect
			.element(documentsPanel.getByRole('button', { name: 'Download final PDF' }))
			.toBeVisible();
	});

	it('shows an explicit error, not a blank pane, when the sent document set cannot be loaded', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse(sentDetail);
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					throw new Error('network unavailable');
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(deliveries);
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
		await expect
			.element(
				documentsPanel.getByText('The sent documents could not be loaded. Please try again.')
			)
			.toBeVisible();
		expect(documentsPanel.element().textContent).not.toContain(
			"This envelope's documents can no longer be edited."
		);
	});
});
