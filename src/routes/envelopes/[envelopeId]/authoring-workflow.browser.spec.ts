import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage, userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';
import EnvelopePageMobileTestHost from './envelope-page-mobile-test-host.svelte';
import '../../layout.css';

vi.mock('$lib/components/pdf-document-view.svelte', async () => ({
	default: (await import('./field-placement-pdf-view-test-stub.svelte')).default
}));

const { ENVELOPE_ID, navigationCallbacks } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000040',
	navigationCallbacks: [] as ((navigation: { willUnload: boolean; cancel(): void }) => void)[]
}));
const READY_AUDIT_ID = '01900000-0000-7000-8000-000000000099';
const SIGNER_ID = '01900000-0000-7000-8000-000000000011';
const DOCUMENT_ID = '01900000-0000-7000-8000-000000000010';

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

vi.mock('$app/navigation', () => ({
	beforeNavigate: (callback: (navigation: { willUnload: boolean; cancel(): void }) => void) => {
		navigationCallbacks.push(callback);
	}
}));

afterEach(async () => {
	navigationCallbacks.length = 0;
	vi.unstubAllGlobals();
	await browserPage.viewport(1280, 800);
});

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

const draftEnvelope = {
	id: ENVELOPE_ID,
	title: 'Agreement',
	status: 'draft' as const,
	repositoryGeneration: 1,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:00:00.000Z'
};

const readyEnvelope = { ...draftEnvelope, status: 'ready' as const };

const draftWorkspace = {
	generation: 1,
	commitSha: draftEnvelope.repositoryHead,
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

const signer = {
	id: SIGNER_ID,
	email: 'signer@example.com',
	name: 'Signer',
	role: 'signer' as const,
	locale: 'en' as const,
	routingOrder: 1,
	status: 'pending'
};

function authoringFieldsResponse(fields: readonly unknown[] = []) {
	return jsonResponse({
		envelopeId: ENVELOPE_ID,
		generation: 1,
		fieldGeneration: readyEnvelope.fieldGeneration,
		commitSha: readyEnvelope.repositoryHead,
		fields
	});
}

function pageMapResponse(): Response {
	return jsonResponse({
		commitSha: readyEnvelope.repositoryHead,
		generation: 1,
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
		]
	});
}

function editableDraftFixture(
	options: {
		failCommit?: boolean;
		failReload?: boolean;
		pauseReady?: Promise<void>;
		retainedRecipients?: boolean;
		multipleDocuments?: boolean;
	} = {}
) {
	let current = { ...draftEnvelope };
	let content = '# Agreement\n';
	let reloadFailed = false;
	const calls: { action: string; body: Record<string, unknown> | undefined }[] = [];
	const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const path = String(url);
		if (path.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`)) {
			return jsonResponse({
				envelope: current,
				recipients: options.retainedRecipients ? [signer] : [],
				readyAuditEventId: null,
				fields: []
			});
		}
		if (path.endsWith('/draft/commits')) {
			const body = parseBody(init);
			calls.push({ action: 'commit', body });
			if (options.failCommit) return jsonResponse({ detail: 'Could not save documents.' }, 503);
			content = (body?.edits as { content: string }[])[0].content;
			current = {
				...current,
				repositoryGeneration: current.repositoryGeneration + 1,
				repositoryHead: 'b'.repeat(40)
			};
			return jsonResponse({
				revision: {
					generation: current.repositoryGeneration,
					commitSha: current.repositoryHead,
					archiveSha256: 'a'.repeat(64)
				}
			});
		}
		if (path.endsWith('/ready')) {
			calls.push({ action: 'ready', body: parseBody(init) });
			await options.pauseReady;
			return jsonResponse({ detail: 'Could not save recipients.' }, 503);
		}
		if (
			path.includes('/documents/pdf?') ||
			path.includes('/draft/docx?') ||
			path.endsWith('/documents/order')
		) {
			const operation = path.endsWith('/documents/order')
				? 'order'
				: path.includes('/documents/pdf?')
					? 'pdf'
					: 'docx';
			const body =
				operation === 'order'
					? parseBody(init)
					: {
							expectedGeneration: Number(
								new URL(path, 'https://signkit.example').searchParams.get('expectedGeneration')
							)
						};
			calls.push({ action: operation, body });
			return jsonResponse({ detail: 'Could not change the document list.' }, 503);
		}
		if (path.endsWith('/draft')) {
			if (options.failReload && current.repositoryGeneration > 1 && !reloadFailed) {
				reloadFailed = true;
				return jsonResponse({ detail: 'Documents could not be reloaded.' }, 503);
			}
			return jsonResponse({
				...draftWorkspace,
				generation: current.repositoryGeneration,
				commitSha: current.repositoryHead,
				documents: [{ path: 'documents/agreement.md', content }],
				documentSet: {
					...draftWorkspace.documentSet,
					documents: options.multipleDocuments
						? [
								...draftWorkspace.documentSet.documents,
								{
									...draftWorkspace.documentSet.documents[0],
									id: '01900000-0000-7000-8000-000000000030',
									path: 'documents/appendix.md',
									title: 'Appendix',
									position: 1
								}
							]
						: draftWorkspace.documentSet.documents
				}
			});
		}
		return jsonResponse({});
	});
	return { mockFetch, calls };
}

describe('guided sender workflow', () => {
	it('shows the contract title without a technical disclosure beneath it', async () => {
		const { mockFetch } = editableDraftFixture();
		vi.stubGlobal('fetch', mockFetch);
		const screen = await render(EnvelopePage);
		const title = screen.getByRole('heading', { level: 1, name: 'Agreement' });

		await expect.element(title).toBeVisible();
		expect(title.element().parentElement?.textContent?.trim()).toBe('Agreement');
	});

	it('prevents recipient edits during a request and unlocks them after a failure', async () => {
		let resumeReady: (() => void) | undefined;
		const pauseReady = new Promise<void>((resolve) => {
			resumeReady = resolve;
		});
		const fixture = editableDraftFixture({ pauseReady });
		vi.stubGlobal('fetch', fixture.mockFetch);
		const screen = await render(EnvelopePage);
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByLabelText('Email').fill('signer@example.com');
		await screen.getByLabelText('Name').fill('Signer');
		await screen.getByRole('button', { name: 'Choose signature positions' }).click();
		try {
			await expect.poll(() => fixture.calls.map((call) => call.action)).toEqual(['ready']);
			await expect.element(screen.getByLabelText('Email')).toBeDisabled();
			await expect.element(screen.getByLabelText('Name')).toBeDisabled();
			await expect.element(screen.getByRole('button', { name: 'Add recipient' })).toBeDisabled();
		} finally {
			resumeReady?.();
		}
		await expect.element(screen.getByText('Could not save recipients.')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Add recipient' })).toBeEnabled();
		await expect.element(screen.getByLabelText('Email')).toHaveValue('signer@example.com');
		await expect.element(screen.getByLabelText('Email')).toBeEnabled();
	});
	it.each(['pdf', 'docx', 'order'] as const)(
		'stops the %s mutation when the saved document list cannot be reloaded',
		async (operation) => {
			const fixture = editableDraftFixture({
				failReload: true,
				multipleDocuments: operation === 'order'
			});
			vi.stubGlobal('fetch', fixture.mockFetch);
			const screen = await render(EnvelopePage);
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await screen.getByLabelText('Document content').fill('# Saved before the failed reload\n');
			if (operation === 'order') {
				await screen.getByRole('button', { name: 'Move down' }).first().click();
			} else {
				await screen.getByRole('button', { name: 'Add document' }).click();
				await userEvent.upload(
					screen.getByLabelText(operation === 'pdf' ? 'Upload PDF' : 'Upload Word document'),
					new File(['synthetic fixture'], `test.${operation}`, {
						type:
							operation === 'pdf'
								? 'application/pdf'
								: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
					})
				);
			}
			await expect.element(screen.getByText('Documents could not be reloaded.')).toBeVisible();
			expect(fixture.calls.map((call) => call.action)).toEqual(['commit']);
			await screen.getByRole('button', { name: 'Retry', exact: true }).click();
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await expect
				.element(screen.getByLabelText('Document content'))
				.toHaveValue('# Saved before the failed reload\n');
			expect(fixture.calls.map((call) => call.action)).toEqual(['commit']);
		}
	);
	it.each(['pdf', 'docx', 'order'] as const)(
		'saves unsaved text before the %s document-list mutation',
		async (operation) => {
			const fixture = editableDraftFixture({ multipleDocuments: operation === 'order' });
			vi.stubGlobal('fetch', fixture.mockFetch);
			const screen = await render(EnvelopePage);
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await screen.getByLabelText('Document content').fill('# Preserve this edited text\n');
			if (operation === 'order') {
				await screen.getByRole('button', { name: 'Move down' }).first().click();
			} else {
				await screen.getByRole('button', { name: 'Add document' }).click();
				await userEvent.upload(
					screen.getByLabelText(operation === 'pdf' ? 'Upload PDF' : 'Upload Word document'),
					new File(['synthetic fixture'], `test.${operation}`, {
						type:
							operation === 'pdf'
								? 'application/pdf'
								: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
					})
				);
			}
			await expect.element(screen.getByText('Could not change the document list.')).toBeVisible();
			expect(fixture.calls.map((call) => call.action)).toEqual(['commit', operation]);
			expect(fixture.calls[1].body?.expectedGeneration).toBe(2);
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await expect
				.element(screen.getByLabelText('Document content'))
				.toHaveValue('# Preserve this edited text\n');
		}
	);

	it.each([false, true])(
		'saves dirty documents even after a direct tab jump; commit failure=%s',
		async (failCommit) => {
			const fixture = editableDraftFixture({ failCommit });
			vi.stubGlobal('fetch', fixture.mockFetch);
			const screen = await render(EnvelopePage);
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await screen.getByLabelText('Document content').fill('# Edited before choosing recipients\n');
			await screen.getByRole('tab', { name: 'Recipients' }).click();
			await screen.getByRole('button', { name: 'Add recipient' }).click();
			await screen.getByLabelText('Email').fill('signer@example.com');
			await screen.getByLabelText('Name').fill('Signer');
			await screen.getByRole('button', { name: 'Choose signature positions' }).click();
			await expect
				.element(
					screen
						.getByRole('tabpanel', { name: 'Recipients' })
						.getByText(failCommit ? 'Could not save documents.' : 'Could not save recipients.')
				)
				.toBeVisible();
			expect(fixture.calls.map((call) => call.action)).toEqual(
				failCommit ? ['commit'] : ['commit', 'ready']
			);
			expect(fixture.calls[0].body?.edits).toEqual([
				{ path: 'documents/agreement.md', content: '# Edited before choosing recipients\n' }
			]);
			if (!failCommit) expect(fixture.calls[1].body?.expectedGeneration).toBe(2);
			await expect.element(screen.getByLabelText('Email')).toHaveValue('signer@example.com');
			await expect.element(screen.getByLabelText('Name')).toHaveValue('Signer');
			await screen.getByRole('tab', { name: 'Documents' }).click();
			await screen.getByRole('button', { name: 'Edit document text' }).click();
			await expect
				.element(screen.getByLabelText('Document content'))
				.toHaveValue('# Edited before choosing recipients\n');
		}
	);

	it('does not resurrect a removed retained recipient after saving document edits', async () => {
		const fixture = editableDraftFixture({ retainedRecipients: true });
		vi.stubGlobal('fetch', fixture.mockFetch);
		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await expect.element(screen.getByLabelText('Email')).toHaveValue(signer.email);
		await screen.getByRole('button', { name: 'Remove', exact: true }).click();
		await screen.getByRole('tab', { name: 'Documents' }).click();
		await screen.getByRole('button', { name: 'Edit document text' }).click();
		await screen.getByLabelText('Document content').fill('# Saved without restoring recipients\n');
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();
		expect(fixture.calls.map((call) => call.action)).toEqual(['commit']);
		expect(screen.container.querySelector('input[type="email"]')).toBeNull();
	});

	it('guards reload and internal navigation for unsaved recipient edits without a double prompt', async () => {
		vi.stubGlobal('fetch', editableDraftFixture().mockFetch);
		const confirm = vi.fn(() => false);
		vi.stubGlobal('confirm', confirm);
		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		let event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByLabelText('Email').fill('unsaved@example.com');
		event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		const cancel = vi.fn();
		navigationCallbacks.at(-1)?.({ willUnload: false, cancel });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		navigationCallbacks.at(-1)?.({ willUnload: true, cancel });
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('offers a working next action for an empty recipient step and focuses its first error', async () => {
		const fixture = editableDraftFixture();
		vi.stubGlobal('fetch', fixture.mockFetch);
		const screen = await render(EnvelopePage);
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();
		const next = screen.getByRole('button', { name: 'Continue to review' });
		await expect.element(next).toBeEnabled();
		await next.click();
		await expect.element(screen.getByLabelText('Email')).toHaveFocus();
		await expect
			.element(screen.getByText('Enter a valid email address for this recipient.'))
			.toBeVisible();
		expect(fixture.calls).toEqual([]);
	});

	it('keeps draft forms within a 390px viewport and supports keyboard validation', async () => {
		await browserPage.viewport(390, 844);
		const fixture = editableDraftFixture();
		vi.stubGlobal('fetch', fixture.mockFetch);
		const screen = await render(EnvelopePageMobileTestHost);
		await expect.element(screen.getByRole('button', { name: 'Add document' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Continue to recipients' }))
			.toBeVisible();
		expect(window.innerWidth).toBe(390);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		const email = screen.getByLabelText('Email');
		await email.fill('bad-email');
		await userEvent.keyboard('{Enter}');
		await expect.element(email).toHaveFocus();
		await expect
			.element(screen.getByText('Enter a valid email address for this recipient.'))
			.toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
		expect(
			screen.getByLabelText('Name').element().getBoundingClientRect().right
		).toBeLessThanOrEqual(390);
		expect(fixture.calls).toEqual([]);
	});
	it('saves documents before continuing and stays put when save fails, keeping the typed text', async () => {
		let commitCalled = false;
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: draftEnvelope,
					recipients: [],
					readyAuditEventId: null,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft/commits`)) {
				commitCalled = true;
				return new Response(
					JSON.stringify({
						type: 'urn:signkit:problem:service-unavailable',
						title: 'Unavailable',
						status: 503,
						detail: 'Could not save documents.'
					}),
					{ status: 503, headers: { 'content-type': 'application/problem+json' } }
				);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect
			.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
			.toBeVisible();
		await expect.element(screen.getByText('Step 1 of 4: Documents')).toBeVisible();

		await screen.getByRole('button', { name: 'Edit document text' }).click();
		const editor = screen.getByLabelText('Document content');
		await editor.fill('# Kept draft\n');
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();

		expect(commitCalled).toBe(true);
		await expect
			.element(
				screen.getByRole('tabpanel', { name: 'Documents' }).getByText('Could not save documents.')
			)
			.toBeVisible();
		await expect.element(screen.getByText('Step 1 of 4: Documents')).toBeVisible();
		await expect.element(editor).toHaveValue('# Kept draft\n');
	});

	it('walks recipients into signature placement through an internal ready call', async () => {
		let status: 'draft' | 'ready' = 'draft';
		let readyBody: Record<string, unknown> | undefined;
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: status === 'ready' ? readyEnvelope : draftEnvelope,
					recipients: status === 'ready' ? [signer] : [],
					readyAuditEventId: status === 'ready' ? READY_AUDIT_ID : null,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/ready`) && init?.method === 'POST') {
				readyBody = parseBody(init);
				status = 'ready';
				return jsonResponse({
					ready: {
						envelopeId: ENVELOPE_ID,
						status: 'ready',
						generation: 1,
						commitSha: draftWorkspace.commitSha,
						recipients: [signer],
						updatedAt: '2026-10-11T00:00:00.000Z',
						auditEventId: READY_AUDIT_ID
					}
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return authoringFieldsResponse([]);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
				return pageMapResponse();
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf`)) {
				return new Response(new Uint8Array(), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: status, deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await screen.getByRole('button', { name: 'Continue to recipients' }).click();
		await expect.element(screen.getByText('Step 2 of 4: Recipients')).toBeVisible();
		await screen.getByRole('button', { name: 'Add recipient' }).click();
		await screen.getByLabelText('Email').fill('signer@example.com');
		await screen.getByLabelText('Name').fill('Signer');
		await screen.getByRole('button', { name: 'Choose signature positions' }).click();

		await expect.poll(() => readyBody !== undefined).toBe(true);
		await expect.element(screen.getByText('Step 3 of 4: Signature positions')).toBeVisible();
		await expect.element(screen.getByText('Field placement')).toBeVisible();
	});

	it('blocks send when a signer has no signature position and explains what to fix', async () => {
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: readyEnvelope,
					recipients: [signer],
					readyAuditEventId: READY_AUDIT_ID,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return authoringFieldsResponse([]);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'ready', deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		await expect.element(screen.getByText('Review before sending', { exact: true })).toBeVisible();
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await screen.getByRole('button', { name: 'Choose signature positions' }).click();
		await expect.element(screen.getByText('Step 3 of 4: Signature positions')).toBeVisible();
		expect(
			mockFetch.mock.calls.some(
				([url, init]) => String(url).endsWith('/ready') && init?.method === 'POST'
			)
		).toBe(false);
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		await expect
			.element(screen.getByText('Add a signature position for each signer before sending.'))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Send envelope' })).toBeDisabled();
	});

	it('reopens for corrections only after confirmation and prefills the stored recipients', async () => {
		let status: 'ready' | 'draft' = 'ready';
		let reopenBody: Record<string, unknown> | undefined;
		let currentSigner = signer;
		let fieldsBody: Record<string, unknown> | undefined;
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: status === 'ready' ? readyEnvelope : draftEnvelope,
					recipients: [currentSigner],
					readyAuditEventId: status === 'ready' ? READY_AUDIT_ID : null,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/reopen`) && init?.method === 'POST') {
				reopenBody = parseBody(init);
				status = 'draft';
				return jsonResponse({
					reopened: {
						envelopeId: ENVELOPE_ID,
						status: 'draft',
						generation: 2,
						fieldGeneration: 1,
						updatedAt: '2026-10-11T00:00:00.000Z',
						auditEventId: '01900000-0000-7000-8000-000000000077'
					}
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return authoringFieldsResponse([]);
			}
			if (urlStr.endsWith('/ready') && init?.method === 'POST') {
				status = 'ready';
				currentSigner = { ...signer, id: '01900000-0000-7000-8000-000000000022' };
				return jsonResponse({
					ready: { recipients: [currentSigner], auditEventId: READY_AUDIT_ID }
				});
			}
			if (urlStr.endsWith('/fields') && init?.method === 'POST') {
				fieldsBody = parseBody(init);
				return jsonResponse({ detail: 'Synthetic save unavailable' }, 503);
			}
			if (urlStr.includes('/document-pdf/pages')) return pageMapResponse();
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: status, deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await expect.element(screen.getByRole('button', { name: 'Make a correction' })).toBeVisible();
		expect(reopenBody).toBeUndefined();
		await screen.getByRole('button', { name: 'Make a correction' }).click();
		await expect
			.element(screen.getByRole('heading', { name: 'Edit documents or recipients?' }))
			.toBeVisible();
		await screen
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Make a correction' })
			.click();
		await expect
			.poll(() => reopenBody)
			.toEqual({
				expectedGeneration: 1,
				expectedFieldGeneration: 0,
				expectedReadyAuditEventId: READY_AUDIT_ID
			});
		await screen.getByRole('tab', { name: 'Recipients' }).click();
		await expect
			.poll(() => {
				const email = screen.container.querySelector('#recipient-email-' + SIGNER_ID);
				return email instanceof HTMLInputElement ? email.value : '';
			})
			.toBe('signer@example.com');
		await screen.getByRole('button', { name: 'Choose signature positions' }).click();
		await screen.getByRole('button', { name: 'Add field' }).click();
		await screen.getByRole('button', { name: 'Save signature positions' }).click();
		await expect.poll(() => fieldsBody).toBeDefined();
		expect((fieldsBody?.fields as { recipientId: string }[])[0].recipientId).toBe(currentSigner.id);
		expect(currentSigner.id).not.toBe(SIGNER_ID);
	});

	it('locks placement and withholds publish when the authoring field set cannot be hydrated', async () => {
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: readyEnvelope,
					recipients: [signer],
					readyAuditEventId: READY_AUDIT_ID,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return jsonResponse({ envelopeId: ENVELOPE_ID, fields: null });
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
				return pageMapResponse();
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf`)) {
				return new Response(new Uint8Array(), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'ready', deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Signature positions' }).click();
		await expect
			.element(
				screen.getByText(
					'The current signature field set could not be loaded safely. Try again before editing.'
				)
			)
			.toBeVisible();
		expect(screen.container.querySelector('#field-add-page')).toBeNull();
		expect(screen.container.textContent).not.toContain('Save signature positions');
		expect(
			mockFetch.mock.calls.some(
				(call) =>
					String(call[0]).includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) &&
					(call[1] as RequestInit | undefined)?.method === 'POST'
			)
		).toBe(false);
	});

	it('locks placement when the authoring read is a subset of the public field set', async () => {
		const publicField = {
			id: '01900000-0000-7000-8000-000000000610',
			recipientId: SIGNER_ID,
			documentId: DOCUMENT_ID,
			documentPath: 'documents/agreement.md',
			fieldType: 'signature',
			required: true,
			position: 1,
			geometry: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 }
		};
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: readyEnvelope,
					recipients: [signer],
					readyAuditEventId: READY_AUDIT_ID,
					fields: [
						publicField,
						{ ...publicField, id: '01900000-0000-7000-8000-000000000611', position: 2 }
					]
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return authoringFieldsResponse([{ ...publicField, label: 'Sign here' }]);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf/pages`)) {
				return pageMapResponse();
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/document-pdf`)) {
				return new Response(new Uint8Array(), {
					status: 200,
					headers: { 'content-type': 'application/pdf' }
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'ready', deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Signature positions' }).click();
		await expect
			.element(
				screen.getByText(
					'The current signature field set could not be loaded safely. Try again before editing.'
				)
			)
			.toBeVisible();
		expect(screen.container.querySelector('#field-add-page')).toBeNull();
		expect(screen.container.textContent).not.toContain('Save signature positions');
	});

	it('lets an approval-only envelope skip signature positions and send', async () => {
		const approver = {
			...signer,
			id: '01900000-0000-7000-8000-000000000012',
			role: 'approver' as const
		};
		const mockFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse({
					envelope: readyEnvelope,
					recipients: [approver],
					readyAuditEventId: READY_AUDIT_ID,
					fields: []
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/fields`) && init?.method !== 'POST') {
				return authoringFieldsResponse([]);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse(draftWorkspace);
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'ready', deliveries: [] }
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(EnvelopePage);
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		await expect
			.element(screen.getByText('No signature positions are needed because nobody needs to sign.'))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Send envelope' })).toBeEnabled();
	});
});
