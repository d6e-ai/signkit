import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EnvelopePage from './+page.svelte';

const { ENVELOPE_ID } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000020'
}));
const READY_AUDIT_ID = '01900000-0000-7000-8000-000000000099';
const SIGNER_ID = '01900000-0000-7000-8000-000000000011';

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
});
