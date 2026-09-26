import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page as browserPage, userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';
import EnvelopePageMobileTestHost from './envelope-page-mobile-test-host.svelte';
import '../../layout.css';

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

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
		await expect.element(screen.getByRole('link', { name: 'Download final PDF' })).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (JSON)' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (Markdown)' }))
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
			.element(screen.getByRole('link', { name: 'Download final PDF' }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (JSON)' }))
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
			.element(screen.getByRole('link', { name: 'Download final PDF' }))
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

	it('published: shows the final PDF as the primary preview, with distinctly labeled originals below it', async () => {
		const pdfDocumentId = '01900000-0000-7000-8000-000000000310';
		const workspace = {
			generation: 1,
			commitSha: completedEnvelope.repositoryHead,
			archiveSha256: 'a'.repeat(64),
			documents: [],
			documentSet: {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: pdfDocumentId,
						position: 0,
						kind: 'pdf' as const,
						title: 'signkit-sample-agreement-ja',
						sha256: 'b'.repeat(64),
						byteSize: 12345,
						pageCount: 3,
						pageWidth: 595.28,
						pageHeight: 841.89
					}
				]
			}
		};
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
			(urlStr) =>
				urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)
					? jsonResponse(workspace)
					: undefined
		);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
		await expect
			.element(documentsPanel.getByRole('heading', { name: 'Original documents', level: 2 }))
			.toBeVisible();
		const stubs = documentsPanel.getByTestId('sent-document-pdf-stub').all();
		expect(stubs).toHaveLength(2);
		const sources = stubs.map((stub) => stub.element().getAttribute('data-src'));
		expect(sources).toContain(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/pdf`);
		expect(sources).toContain(
			`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf?documentId=${pdfDocumentId}`
		);
		const primarySourceIndex = documentsPanel
			.element()
			.innerHTML.indexOf(`data-src="/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/pdf"`);
		const originalsHeadingIndex = documentsPanel.element().innerHTML.indexOf('Original documents');
		expect(primarySourceIndex).toBeGreaterThan(-1);
		expect(primarySourceIndex).toBeLessThan(originalsHeadingIndex);

		const downloadPdfLink = documentsPanel.getByRole('link', { name: 'Download final PDF' });
		const downloadJsonLink = documentsPanel.getByRole('link', { name: 'Download evidence (JSON)' });
		const downloadMdLink = documentsPanel.getByRole('link', {
			name: 'Download evidence (Markdown)'
		});
		await expect.element(downloadPdfLink).toBeVisible();
		await expect.element(downloadJsonLink).toBeVisible();
		await expect.element(downloadMdLink).toBeVisible();

		const downloadPdfIndex = documentsPanel.element().innerHTML.indexOf('Download final PDF');
		expect(downloadPdfIndex).toBeLessThan(primarySourceIndex);

		expect(downloadPdfLink.element().getAttribute('href')).toBe(
			`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/pdf`
		);
		expect(downloadPdfLink.element().hasAttribute('download')).toBe(true);
		expect(downloadJsonLink.element().getAttribute('href')).toBe(
			`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/evidence?format=json`
		);
		expect(downloadJsonLink.element().hasAttribute('download')).toBe(true);
		expect(downloadMdLink.element().getAttribute('href')).toBe(
			`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/evidence?format=markdown`
		);
		expect(downloadMdLink.element().hasAttribute('download')).toBe(true);
	});

	it('captures real Chromium download events and byte-exact saved contents for final PDF and JSON evidence', async () => {
		const pdfBytes = new TextEncoder().encode('%PDF-1.7 actual final completion pdf bytes\n');
		const jsonBytes = new TextEncoder().encode(
			JSON.stringify({ schema: 'completion-manifest-v1', envelopeId: ENVELOPE_ID })
		);
		const expectedPdfSha256 = await sha256Hex(pdfBytes);
		const expectedJsonSha256 = await sha256Hex(jsonBytes);

		await commands.startFixtureServer({
			urlPath: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/pdf`,
			status: 200,
			headers: {
				'content-type': 'application/pdf',
				'content-disposition': 'attachment; filename="completed-agreement.pdf"'
			},
			bodyBase64: toBase64(pdfBytes)
		});
		await commands.startFixtureServer({
			urlPath: `/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact/evidence?format=json`,
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-disposition': 'attachment; filename="completion-evidence.json"'
			},
			bodyBase64: toBase64(jsonBytes)
		});

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
		const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });

		// 1. Download Final PDF
		const pdfDownloadPromise = commands.captureDownload({ timeoutMs: 10_000 });
		await documentsPanel.getByRole('link', { name: 'Download final PDF' }).click();
		const pdfResult = await pdfDownloadPromise;
		expect(pdfResult.suggestedFilename).toBe('completed-agreement.pdf');
		expect(pdfResult.byteLength).toBe(pdfBytes.byteLength);
		expect(pdfResult.sha256).toBe(expectedPdfSha256);

		// 2. Download Evidence (JSON)
		const jsonDownloadPromise = commands.captureDownload({ timeoutMs: 10_000 });
		await documentsPanel.getByRole('link', { name: 'Download evidence (JSON)' }).click();
		const jsonResult = await jsonDownloadPromise;
		expect(jsonResult.suggestedFilename).toBe('completion-evidence.json');
		expect(jsonResult.byteLength).toBe(jsonBytes.byteLength);
		expect(jsonResult.sha256).toBe(expectedJsonSha256);

		await commands.stopFixtureServer();
	});

	it('failed: lets the sender retry loading completion status instead of leaving it stuck', async () => {
		let attempt = 0;
		const mockFetch = mockCompletedFetch(() => {
			attempt += 1;
			if (attempt === 1) {
				return jsonResponse({
					completionArtifact: {
						envelopeId: ENVELOPE_ID,
						status: 'failed',
						attempts: 10,
						errorCode: 'completion_artifact_attempts_exhausted',
						availableAt: null
					}
				});
			}
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
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		const retryButton = screen.getByRole('button', { name: 'Retry' });
		await expect.element(retryButton).toBeVisible();
		await retryButton.click();
		await expect.element(screen.getByRole('link', { name: 'Download final PDF' })).toBeVisible();
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
			.element(documentsPanel.getByRole('link', { name: 'Download final PDF' }))
			.toBeVisible();
	});

	it.each(['ready', 'sent', 'in_progress', 'declined', 'voided', 'expired'] as const)(
		'keeps a %s envelope showing the plain original PDF, never the completed-artifact priority treatment',
		async (status) => {
			vi.stubGlobal('fetch', mockSentFetch(pdfOnlyDraft, { ...sentEnvelope, status }));

			const screen = await render(EnvelopePage);
			const documentsPanel = screen.getByRole('tabpanel', { name: 'Documents' });
			await expect.element(documentsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
			const stubs = documentsPanel.getByTestId('sent-document-pdf-stub').all();
			expect(stubs).toHaveLength(1);
			expect(stubs[0]!.element().getAttribute('data-src')).toBe(
				`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf?documentId=${PDF_DOCUMENT_ID}`
			);
			await expect
				.element(documentsPanel.getByRole('heading', { name: 'Original documents', level: 2 }))
				.not.toBeInTheDocument();
			await expect
				.element(documentsPanel.getByRole('link', { name: 'Download final PDF' }))
				.not.toBeInTheDocument();
			await expect
				.element(documentsPanel.getByRole('link', { name: 'Download evidence (JSON)' }))
				.not.toBeInTheDocument();
		}
	);

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

describe('lifecycle beyond sent locks fields and reframes recipients and send status', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	const FIELD_ID = '01900000-0000-7000-8000-000000000401';
	const FIELD_DOCUMENT_ID = '01900000-0000-7000-8000-000000000402';

	const sentEnvelopeWithFields = {
		...readyEnvelope,
		status: 'sent' as const,
		sentCommitSha: readyEnvelope.repositoryHead
	};

	const sentDetailWithFields = {
		envelope: sentEnvelopeWithFields,
		recipients: [
			{
				id: SIGNER_ID,
				email: 'signer@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				locale: 'en',
				routingOrder: 1,
				status: 'completed'
			}
		],
		readyAuditEventId: READY_AUDIT_ID,
		fields: [
			{
				id: FIELD_ID,
				recipientId: SIGNER_ID,
				documentId: FIELD_DOCUMENT_ID,
				documentPath: null,
				fieldType: 'signature',
				required: true,
				position: 1,
				geometry: { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }
			}
		]
	};

	const workspaceWithFieldDocument = {
		generation: 1,
		commitSha: sentEnvelopeWithFields.repositoryHead,
		archiveSha256: 'a'.repeat(64),
		documents: [],
		documentSet: {
			schema: 'signkit-document-set-v1',
			documents: [
				{
					id: FIELD_DOCUMENT_ID,
					position: 0,
					kind: 'pdf' as const,
					title: 'signkit-sample-agreement-ja',
					sha256: 'b'.repeat(64),
					byteSize: 12345,
					pageCount: 1,
					pageWidth: 595.28,
					pageHeight: 841.89
				}
			]
		}
	};

	const deliveredAt = '2026-09-20T09:30:00.000Z';
	const deliveriesWithProgress = {
		delivery: {
			envelopeId: ENVELOPE_ID,
			envelopeStatus: 'sent',
			deliveries: [
				{
					recipientId: SIGNER_ID,
					recipientRole: 'signer',
					routingOrder: 1,
					status: 'delivered',
					attempts: 1,
					availableAt: null,
					deliveredAt,
					updatedAt: deliveredAt,
					errorCode: null
				}
			]
		}
	};

	type LifecycleDetailFixture = Omit<typeof sentDetailWithFields, 'envelope'> & {
		envelope: Omit<typeof sentEnvelopeWithFields, 'status' | 'sentCommitSha'> & {
			status: 'sent' | 'voided';
			sentCommitSha: string | null;
		};
	};

	function mockLifecycleFetch(
		detailOverride: LifecycleDetailFixture = sentDetailWithFields
	): ReturnType<typeof vi.fn> {
		return vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse(detailOverride);
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(workspaceWithFieldDocument);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse(deliveriesWithProgress);
			}
			return jsonResponse({});
		});
	}

	it('Fields tab keeps the placed field visible and read-only once the envelope is sent', async () => {
		vi.stubGlobal('fetch', mockLifecycleFetch());

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Fields' }).click();
		const fieldsPanel = screen.getByRole('tabpanel', { name: 'Fields' });
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Dana Recipient' })).toBeVisible();
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Signature' })).toBeVisible();
		await expect.element(fieldsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect
			.element(
				fieldsPanel.getByText(
					'Field placement is available once this envelope is ready and before it is sent.'
				)
			)
			.not.toBeInTheDocument();
	});

	it('Fields tab shows neutral closed-envelope guidance and no placed fields for an envelope voided before send', async () => {
		const voidedBeforeSendDetail = {
			...sentDetailWithFields,
			envelope: {
				...sentEnvelopeWithFields,
				status: 'voided' as const,
				sentCommitSha: null
			},
			fields: []
		};
		vi.stubGlobal('fetch', mockLifecycleFetch(voidedBeforeSendDetail));

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Fields' }).click();
		const fieldsPanel = screen.getByRole('tabpanel', { name: 'Fields' });

		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope is closed. This shows the field layout as it was published.'
				)
			)
			.toBeVisible();
		await expect
			.element(fieldsPanel.getByText('No fields were placed for this envelope.'))
			.toBeVisible();
		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope has already been sent. This shows the field layout as it was published.'
				)
			)
			.not.toBeInTheDocument();
		await expect
			.element(
				fieldsPanel.getByText(
					'Field placement is available once this envelope is ready and before it is sent.'
				)
			)
			.not.toBeInTheDocument();
		await expect
			.element(fieldsPanel.getByRole('button', { name: 'Publish field set' }))
			.not.toBeInTheDocument();
	});

	it('Fields tab keeps placed field visible read-only with neutral closed copy when ready envelope is voided before send', async () => {
		const readyThenVoidedDetail = {
			...sentDetailWithFields,
			envelope: {
				...sentEnvelopeWithFields,
				status: 'voided' as const,
				sentCommitSha: null
			},
			fields: sentDetailWithFields.fields
		};
		vi.stubGlobal('fetch', mockLifecycleFetch(readyThenVoidedDetail));

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Fields' }).click();
		const fieldsPanel = screen.getByRole('tabpanel', { name: 'Fields' });

		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope is closed. This shows the field layout as it was published.'
				)
			)
			.toBeVisible();
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Dana Recipient' })).toBeVisible();
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Signature' })).toBeVisible();
		await expect.element(fieldsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope has already been sent. This shows the field layout as it was published.'
				)
			)
			.not.toBeInTheDocument();
		await expect
			.element(
				fieldsPanel.getByText(
					'Field placement is available once this envelope is ready and before it is sent.'
				)
			)
			.not.toBeInTheDocument();
		await expect
			.element(fieldsPanel.getByRole('button', { name: 'Publish field set' }))
			.not.toBeInTheDocument();
	});

	it('Fields tab retains existing after-send copy for post-send voided envelope', async () => {
		const postSendVoidedDetail = {
			...sentDetailWithFields,
			envelope: {
				...sentEnvelopeWithFields,
				status: 'voided' as const,
				sentCommitSha: sentEnvelopeWithFields.sentCommitSha
			},
			fields: sentDetailWithFields.fields
		};
		vi.stubGlobal('fetch', mockLifecycleFetch(postSendVoidedDetail));

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Fields' }).click();
		const fieldsPanel = screen.getByRole('tabpanel', { name: 'Fields' });

		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope has already been sent. This shows the field layout as it was published.'
				)
			)
			.toBeVisible();
		await expect
			.element(
				fieldsPanel.getByText(
					'Fields are locked because this envelope is closed. This shows the field layout as it was published.'
				)
			)
			.not.toBeInTheDocument();
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Dana Recipient' })).toBeVisible();
		await expect.element(fieldsPanel.getByRole('cell', { name: 'Signature' })).toBeVisible();
		await expect.element(fieldsPanel.getByText('signkit-sample-agreement-ja')).toBeVisible();
		await expect
			.element(
				fieldsPanel.getByText(
					'Field placement is available once this envelope is ready and before it is sent.'
				)
			)
			.not.toBeInTheDocument();
		await expect
			.element(fieldsPanel.getByRole('button', { name: 'Publish field set' }))
			.not.toBeInTheDocument();
	});

	it('Recipients tab shows response-progress framing, not draft-time readiness guidance, once sent', async () => {
		vi.stubGlobal('fetch', mockLifecycleFetch());

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		const recipientsPanel = screen.getByRole('tabpanel', { name: 'Recipients' });
		await expect
			.element(recipientsPanel.getByText("Each recipient's response progress for this envelope."))
			.toBeVisible();
		await expect
			.element(
				recipientsPanel.getByText(
					'Declare the complete recipient graph, then mark this envelope ready to freeze it.'
				)
			)
			.not.toBeInTheDocument();
	});

	it('Send & status tab drops the pre-send instructions and shows delivery and response progress distinctly', async () => {
		vi.stubGlobal('fetch', mockLifecycleFetch());

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		const sendPanel = screen.getByRole('tabpanel', { name: 'Send & status' });
		await expect
			.element(sendPanel.getByText('This envelope must be ready before it can be sent.'))
			.not.toBeInTheDocument();
		await expect.element(sendPanel.getByText('Email sent')).toBeVisible();
		await expect.element(sendPanel.getByText('Completed')).toBeVisible();
		const expectedDeliveredAt = new Intl.DateTimeFormat('en', {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(deliveredAt));
		await expect.element(sendPanel.getByText(`Delivered ${expectedDeliveredAt}`)).toBeVisible();
	});
});

describe('completed envelope on actual 390x844 mobile viewport with keyboard tab navigation', () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await browserPage.viewport(390, 844);
	});

	afterEach(async () => {
		await commands.stopFixtureServer();
		await browserPage.viewport(1280, 800);
	});

	const completedEnvelope = {
		...readyEnvelope,
		status: 'completed' as const,
		sentCommitSha: '0123456789abcdef0123456789abcdef01234567'
	};

	const completedDetail = { ...detail, envelope: completedEnvelope };

	const deliveredAt = '2026-09-20T09:30:00.000Z';
	const deliveriesWithProgress = {
		delivery: {
			envelopeId: ENVELOPE_ID,
			envelopeStatus: 'completed',
			deliveries: [
				{
					recipientId: SIGNER_ID,
					recipientRole: 'signer',
					routingOrder: 1,
					status: 'delivered',
					attempts: 1,
					availableAt: null,
					deliveredAt,
					updatedAt: deliveredAt,
					errorCode: null
				}
			]
		}
	};

	function mockCompletedEnvFetch(): ReturnType<typeof vi.fn> {
		return vi.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse(completedDetail);
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draft);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse(deliveriesWithProgress);
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
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`)) {
				return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' } });
			}
			return jsonResponse({});
		});
	}

	it('asserts actual innerWidth=390 and has no page-wide horizontal overflow across Documents, Recipients, Fields, and Send tabs', async () => {
		expect(window.innerWidth).toBe(390);

		vi.stubGlobal('fetch', mockCompletedEnvFetch());

		const screen = await render(EnvelopePageMobileTestHost);
		const container = screen.getByTestId('shared-layout-container').element() as HTMLElement;
		const containerStyle = window.getComputedStyle(container);

		// Verify real app layout CSS is active (Tailwind flex utility computes to display: flex)
		const flexElement = container.querySelector('.flex') as HTMLElement;
		expect(flexElement).not.toBeNull();
		expect(window.getComputedStyle(flexElement).display).toBe('flex');

		// Shared layout container matches the 390px mobile viewport with px-4 (usable inner width 358px)
		expect(container.clientWidth).toBe(390);
		expect(containerStyle.paddingLeft).toBe('16px');
		expect(containerStyle.paddingRight).toBe('16px');
		const usableInnerWidth =
			container.clientWidth -
			parseFloat(containerStyle.paddingLeft) -
			parseFloat(containerStyle.paddingRight);
		expect(usableInnerWidth).toBe(358);

		const tabs = ['Documents', 'Recipients', 'Fields', 'Send'] as const;
		for (const tabName of tabs) {
			const trigger = screen.getByRole('tab', { name: tabName });
			await trigger.click();
			const panel = screen.getByRole('tabpanel', { name: tabName });
			await expect.element(panel).toBeVisible();

			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
			expect(document.body.scrollWidth).toBeLessThanOrEqual(390);
			expect(container.scrollWidth).toBeLessThanOrEqual(390);
		}
	});

	it('supports keyboard-only navigation across named tabs and keeps PDF fallback and download controls visible', async () => {
		expect(window.innerWidth).toBe(390);

		vi.stubGlobal('fetch', mockCompletedEnvFetch());

		const screen = await render(EnvelopePageMobileTestHost);

		await expect.element(screen.getByRole('tabpanel', { name: 'Documents' })).toBeVisible();

		await expect.element(screen.getByRole('link', { name: 'Download final PDF' })).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (JSON)' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (Markdown)' }))
			.toBeVisible();
		await expect.element(screen.getByRole('link', { name: 'Open final PDF' })).toBeVisible();

		const documentsTab = screen.getByRole('tab', { name: 'Documents' });
		documentsTab.element().focus();
		expect(document.activeElement).toBe(documentsTab.element());

		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Recipients' })).toBeVisible();

		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Fields' })).toBeVisible();

		await userEvent.keyboard('{ArrowRight}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Send' })).toBeVisible();

		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Fields' })).toBeVisible();

		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Recipients' })).toBeVisible();

		await userEvent.keyboard('{ArrowLeft}');
		await expect.element(screen.getByRole('tabpanel', { name: 'Documents' })).toBeVisible();
		await expect.element(screen.getByRole('link', { name: 'Download final PDF' })).toBeVisible();
	});
});
