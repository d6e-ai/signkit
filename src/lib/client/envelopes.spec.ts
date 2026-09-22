import { describe, expect, it, vi } from 'vitest';
import {
	createEnvelopesClient,
	fetchAllEnvelopes,
	EnvelopesApiError,
	MAX_ENVELOPE_LIST_PAGES,
	type Envelope,
	type ListEnvelopesResponse,
	type RequestOptions
} from './envelopes';

function mockJsonResponse(
	data: unknown,
	status = 200,
	headersInit?: Record<string, string>
): Response {
	const headers = new Headers({ 'content-type': 'application/json', ...headersInit });
	return new Response(JSON.stringify(data), { status, headers });
}

function mockProblemResponse(
	problem: { type: string; title: string; status: number; detail: string; instance: string },
	headersInit?: Record<string, string>
): Response {
	const headers = new Headers({ 'content-type': 'application/problem+json', ...headersInit });
	return new Response(JSON.stringify(problem), { status: problem.status, headers });
}

const envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	createdByUserId: '01900000-0000-7000-8000-000000000099',
	title: 'Agreement',
	status: 'draft' as const,
	repositoryGeneration: 0,
	repositoryHead: null,
	repositoryArchiveSha256: null,
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:00:00.000Z'
};

describe('EnvelopesClient', () => {
	it('mints an Idempotency-Key and posts a new envelope', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ envelope }, 201)
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result = await client.create('Agreement');

		expect(result.envelope).toEqual(envelope);
		expect(result.replayed).toBe(false);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/envelopes');
		const headers = init?.headers as Record<string, string>;
		expect(headers['idempotency-key']).toBeTruthy();
		expect(JSON.parse(init?.body as string)).toEqual({ title: 'Agreement' });
	});

	it('lists envelopes with cursor and limit query params', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ items: [envelope], nextCursor: null })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result = await client.list({ cursor: 'abc', limit: 10 });

		expect(result.items).toEqual([envelope]);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/envelopes?cursor=abc&limit=10');
	});

	it('reads the draft workspace', async () => {
		const workspace = {
			generation: 1,
			commitSha: '0123456789abcdef0123456789abcdef01234567',
			archiveSha256: 'a'.repeat(64),
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }],
			documentSet: null
		};
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(workspace));
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.getDraft(envelope.id)).resolves.toEqual(workspace);
		expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/envelopes/${envelope.id}/draft`);
	});

	it('reads the durable envelope detail including recipients and the ready audit event', async () => {
		const detail = {
			envelope,
			recipients: [
				{
					id: '01900000-0000-7000-8000-000000000011',
					email: 'signer@example.com',
					name: 'Signer',
					role: 'signer',
					locale: 'en',
					routingOrder: 1,
					status: 'pending'
				}
			],
			readyAuditEventId: '01900000-0000-7000-8000-000000000099',
			fields: []
		};
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse(detail));
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.getDetail(envelope.id)).resolves.toEqual(detail);
		await expect(client.get(envelope.id)).resolves.toEqual(envelope);
	});

	it('imports a DOCX file as a raw body with metadata in the query string', async () => {
		const revision = { generation: 1, commitSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ revision }, 201)
		);
		const client = createEnvelopesClient({ fetch: fetchMock });
		const file = new Blob(['PK'], {
			type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		});

		await client.importDocx(envelope.id, {
			expectedGeneration: 0,
			targetPath: 'documents/agreement.md',
			file
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			`/api/v1/envelopes/${envelope.id}/draft/docx?targetPath=documents%2Fagreement.md&expectedGeneration=0`
		);
		expect(init?.body).toBe(file);
		const headers = init?.headers as Record<string, string>;
		expect(headers['content-type']).toBe(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
	});

	it('uploads a PDF file as a raw body with metadata in the query string', async () => {
		const revision = { generation: 1, commitSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ revision }, 201)
		);
		const client = createEnvelopesClient({ fetch: fetchMock });
		const file = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

		await client.uploadPdf(envelope.id, {
			expectedGeneration: 0,
			file,
			title: 'Employment Agreement',
			position: 2
		});

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			`/api/v1/envelopes/${envelope.id}/documents/pdf?expectedGeneration=0&title=Employment+Agreement&position=2`
		);
		expect(init?.body).toBe(file);
		const headers = init?.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/pdf');
	});

	it('downloads commit-pinned DOCX bytes without JSON parsing', async () => {
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		const fetchMock = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(bytes, {
					status: 200,
					headers: {
						'content-type':
							'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
						'content-disposition': 'attachment; filename="envelope-export.docx"',
						'x-signkit-commit-sha': 'a'.repeat(40)
					}
				})
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.exportDocx(envelope.id)).resolves.toEqual({
			bytes,
			commitSha: 'a'.repeat(40),
			filename: 'envelope-export.docx'
		});
		expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/envelopes/${envelope.id}/docx`);
	});

	it('marks a replayed commit via the idempotency-replayed response header', async () => {
		const revision = { generation: 1, commitSha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ revision }, 201, { 'idempotency-replayed': 'true' })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result = await client.commitDraft(envelope.id, {
			expectedGeneration: 0,
			message: 'Initial draft',
			edits: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
		});

		expect(result.replayed).toBe(true);
		expect(result.revision).toEqual(revision);
	});

	it('surfaces an RFC 9457 problem as EnvelopesApiError', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockProblemResponse({
				type: 'urn:signkit:problem:draft-generation-conflict',
				title: 'Draft generation conflict',
				status: 409,
				detail: 'The expected draft generation is no longer current.',
				instance: '/api/v1/envelopes/x/draft/commits'
			})
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(
			client.commitDraft(envelope.id, {
				expectedGeneration: 0,
				message: 'Initial draft',
				edits: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
			})
		).rejects.toMatchObject({
			status: 409,
			type: 'urn:signkit:problem:draft-generation-conflict'
		});
	});

	it('sends the ready command and returns the recipient graph', async () => {
		const ready = {
			envelopeId: envelope.id,
			status: 'ready' as const,
			generation: 1,
			commitSha: 'a'.repeat(40),
			recipients: [],
			updatedAt: '2026-09-11T00:00:00.000Z',
			auditEventId: '01900000-0000-7000-8000-000000000099'
		};
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => mockJsonResponse({ ready }));
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result = await client.ready(envelope.id, {
			expectedGeneration: 1,
			recipients: [
				{ email: 'a@example.com', name: 'Alice', role: 'signer', locale: 'en', routingOrder: 1 }
			]
		});

		expect(result.ready).toEqual(ready);
	});

	it('propagates a network failure as-is', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error('network down');
		});
		const client = createEnvelopesClient({ fetch: fetchMock });
		await expect(client.get(envelope.id)).rejects.toThrow('network down');
	});

	it('EnvelopesApiError falls back to a generic message when detail is empty', () => {
		const error = new EnvelopesApiError({
			status: 503,
			type: 'urn:signkit:problem:service-unavailable',
			title: '',
			detail: ''
		});
		expect(error.message).toBe('Request failed with status 503');
	});

	it('reads the completion artifact status, including the coarse PDF status', async () => {
		const completionArtifact = {
			envelopeId: envelope.id,
			status: 'published' as const,
			publishedAt: '2026-09-12T00:00:00.000Z',
			manifestSha256: 'm'.repeat(64),
			jsonSha256: 'j'.repeat(64),
			markdownSha256: 'd'.repeat(64),
			pdfStatus: 'pending' as const
		};
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ completionArtifact })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.completionArtifactStatus(envelope.id)).resolves.toEqual(completionArtifact);
		expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/envelopes/${envelope.id}/completion-artifact`);
	});

	it('downloads the completion PDF, taking the filename from Content-Disposition', async () => {
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		const fetchMock = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(bytes, {
					status: 200,
					headers: {
						'content-type': 'application/pdf',
						'content-disposition': `attachment; filename="completion-${envelope.id}.pdf"`
					}
				})
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.completionPdf(envelope.id)).resolves.toEqual({
			bytes,
			filename: `completion-${envelope.id}.pdf`
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			`/api/v1/envelopes/${envelope.id}/completion-artifact/pdf`
		);
	});

	it('falls back to a default PDF filename when Content-Disposition is missing', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(
			async () => new Response(new Uint8Array([1]), { status: 200 })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.completionPdf(envelope.id)).resolves.toMatchObject({
			filename: `completion-${envelope.id}.pdf`
		});
	});

	it('downloads completion evidence in the requested format', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response('# Evidence', {
					status: 200,
					headers: {
						'content-type': 'text/markdown; charset=utf-8',
						'content-disposition': `attachment; filename="completion-evidence-${envelope.id}.md"`
					}
				})
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.completionEvidence(envelope.id, 'markdown')).resolves.toEqual({
			content: '# Evidence',
			filename: `completion-evidence-${envelope.id}.md`,
			contentType: 'text/markdown; charset=utf-8'
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			`/api/v1/envelopes/${envelope.id}/completion-artifact/evidence?format=markdown`
		);
	});

	it('surfaces a problem response when completion artifact downloads fail', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockProblemResponse({
				type: 'urn:signkit:problem:completion-pdf-not-found',
				title: 'Completion PDF not published',
				status: 404,
				detail: 'Completion PDF artifact has not been published for this envelope.',
				instance: `/api/v1/envelopes/${envelope.id}/completion-artifact/pdf`
			})
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		await expect(client.completionPdf(envelope.id)).rejects.toMatchObject({
			status: 404,
			type: 'urn:signkit:problem:completion-pdf-not-found'
		});
	});
});

describe('fetchAllEnvelopes', () => {
	function envelopeAt(index: number): Envelope {
		return {
			...envelope,
			id: `01900000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`
		};
	}

	it('follows nextCursor until it is null, concatenating every page', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>();
		fetchMock
			.mockResolvedValueOnce(
				mockJsonResponse({ items: [envelopeAt(1), envelopeAt(2)], nextCursor: 'page-2' })
			)
			.mockResolvedValueOnce(mockJsonResponse({ items: [envelopeAt(3)], nextCursor: null }));
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result: Envelope[] = await fetchAllEnvelopes(client);

		expect(result.map((item) => item.id)).toEqual([
			envelopeAt(1).id,
			envelopeAt(2).id,
			envelopeAt(3).id
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [firstUrl] = fetchMock.mock.calls[0];
		const [secondUrl] = fetchMock.mock.calls[1];
		expect(firstUrl).toBe('/api/v1/envelopes?limit=100');
		expect(secondUrl).toBe('/api/v1/envelopes?cursor=page-2&limit=100');
	});

	it('returns every item across a single page with no further cursor', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ items: [envelope], nextCursor: null })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });

		const result: Envelope[] = await fetchAllEnvelopes(client);

		expect(result).toEqual([envelope]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('stops at the page-count safety ceiling instead of looping forever on a cursor that never ends', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ items: [envelope], nextCursor: 'always-more' })
		);
		const client = createEnvelopesClient({ fetch: fetchMock });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const result: Envelope[] = await fetchAllEnvelopes(client);

		expect(fetchMock).toHaveBeenCalledTimes(MAX_ENVELOPE_LIST_PAGES);
		expect(result).toHaveLength(MAX_ENVELOPE_LIST_PAGES);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('forwards request options like a custom fetch to every page', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			mockJsonResponse({ items: [envelope], nextCursor: null })
		);
		const options: RequestOptions = { fetch: fetchMock };

		await fetchAllEnvelopes(createEnvelopesClient(), options);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('accepts any client exposing just a list method, not only the full EnvelopesClient', async () => {
		const narrowClient: { list: (params?: unknown) => Promise<ListEnvelopesResponse> } = {
			list: async () => ({ items: [envelope], nextCursor: null })
		};

		await expect(fetchAllEnvelopes(narrowClient)).resolves.toEqual([envelope]);
	});
});
