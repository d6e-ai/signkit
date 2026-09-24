import { describe, expect, it } from 'vitest';
import {
	DraftDocumentNotFoundError,
	DraftEnvelopeNotFoundError,
	DraftIntegrityError,
	DraftRevisionNotFoundError,
	type DraftExactRevision,
	type DraftPersistenceService,
	type DraftRevisionHistoryPage
} from '$lib/application/drafts/draft-persistence';
import type { RevisionDiffResult } from '$lib/domain/revision-diff';
import { createRevisionHttpHandlers, type RevisionPersistenceResolver } from './revisions';
import { createHttpRequestEvent, instanceScopedLocals } from './http-handler-test-support';

const envelopeId = '01900000-0000-7000-8000-000000000001';
type RevisionPersistencePort = Pick<
	DraftPersistenceService,
	'listRevisions' | 'readRevision' | 'diffRevisions'
>;

function locals(state: App.Locals['identityState'] = 'active'): App.Locals {
	return instanceScopedLocals(state);
}

function mockPage(): DraftRevisionHistoryPage {
	const revisions = [
		{
			generation: 2,
			commitSha: '2'.repeat(40),
			timestamp: '2026-09-12T00:00:00.000Z',
			message: 'Second revision',
			actorType: 'user' as const,
			provenance: {
				automationRunId: 'auto-run-2'
			}
		},
		{
			generation: 1,
			commitSha: '1'.repeat(40),
			timestamp: '2026-09-11T00:00:00.000Z',
			message: 'Initial revision',
			actorType: 'system' as const
		}
	];
	return {
		revisions,
		truncated: false,
		nextCursor: null
	};
}

function mockExactRevision(): DraftExactRevision {
	return {
		generation: 2,
		commitSha: '2'.repeat(40),
		archiveSha256: 'a'.repeat(64),
		timestamp: '2026-09-12T00:00:00.000Z',
		message: 'Second revision',
		actorType: 'user',
		provenance: {
			automationRunId: 'auto-run-2'
		},
		documents: [
			{
				path: 'documents/agreement.md',
				content: '# Agreement\n\nTerms and conditions.'
			}
		],
		documentSet: {
			schema: 'signkit-document-set-v1',
			documents: [
				{
					id: '01900000-0000-7000-8000-000000000010',
					position: 0,
					kind: 'markdown',
					title: 'agreement',
					path: 'documents/agreement.md',
					contentSha256: 'b'.repeat(64)
				}
			]
		},
		selectedDocument: {
			path: 'documents/agreement.md',
			content: '# Agreement\n\nTerms and conditions.'
		}
	};
}

function mockDiffResult(): RevisionDiffResult {
	const unifiedDiff =
		'--- a/documents/agreement.md\n+++ b/documents/agreement.md\n@@ -1 +1,2 @@\n # Agreement\n+Terms and conditions.\n';
	return {
		schema: 'signkit-revision-diff-v1',
		base: {
			generation: 1,
			commitSha: '1'.repeat(40)
		},
		head: {
			generation: 2,
			commitSha: '2'.repeat(40),
			message: 'Second revision'
		},
		summary: {
			documentsAdded: 0,
			documentsRemoved: 0,
			documentsModified: 1,
			documentsReordered: 0,
			titlesChanged: 0,
			totalChanges: 1
		},
		changes: [
			{
				documentId: '01900000-0000-7000-8000-000000000010',
				kind: 'markdown',
				path: 'documents/agreement.md',
				pathChanged: false,
				changeType: 'modified',
				addition: false,
				removal: false,
				titleChanged: false,
				orderChanged: false,
				contentChanged: true,
				title: { current: 'agreement', changed: false },
				position: { current: 0, changed: false },
				content: {
					changed: true,
					previousSha256: 'b'.repeat(64),
					currentSha256: 'c'.repeat(64),
					unifiedDiff,
					additions: 1,
					deletions: 0
				}
			}
		],
		unifiedText: unifiedDiff,
		truncated: false
	};
}

function createMockResolver(
	overrides: Partial<RevisionPersistencePort> = {}
): RevisionPersistenceResolver {
	const service: RevisionPersistencePort = {
		listRevisions: async () => mockPage(),
		readRevision: async () => mockExactRevision(),
		diffRevisions: async () => mockDiffResult(),
		...overrides
	};
	return () => service;
}

describe('RevisionHttpHandlers', () => {
	describe('list', () => {
		it('requires envelopes:read authorization', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions`,
				locals: locals('anonymous'),
				params: { envelopeId }
			});

			const response = await handlers.list(event);
			expect(response.status).toBe(401);
		});

		it('rejects invalid envelopeId', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: '/api/v1/envelopes/not-a-uuid/revisions',
				locals: locals(),
				params: { envelopeId: 'not-a-uuid' }
			});

			const response = await handlers.list(event);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:validation-failed');
		});

		it('rejects a cursor outside the portable generation range', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions`,
				search: '?cursor=999999999999999999999999999999',
				locals: locals(),
				params: { envelopeId }
			});
			expect((await handlers.list(event)).status).toBe(400);
		});

		it('returns bounded revision history without secrets', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions`,
				locals: locals(),
				params: { envelopeId },
				search: '?limit=10'
			});

			const response = await handlers.list(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as DraftRevisionHistoryPage;

			expect(body.revisions).toHaveLength(2);
			expect(body.revisions[0]).toEqual({
				generation: 2,
				commitSha: '2'.repeat(40),
				timestamp: '2026-09-12T00:00:00.000Z',
				message: 'Second revision',
				actorType: 'user',
				provenance: {
					automationRunId: 'auto-run-2'
				}
			});

			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain('archiveKey');
			expect(serialized).not.toContain('audit_payload_json');
			expect(serialized).not.toContain('email');
			expect(serialized).not.toContain('secret');
		});

		it('returns 404 when envelope is not found', async () => {
			const handlers = createRevisionHttpHandlers(
				createMockResolver({
					listRevisions: async () => {
						throw new DraftEnvelopeNotFoundError();
					}
				})
			);
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions`,
				locals: locals(),
				params: { envelopeId }
			});

			const response = await handlers.list(event);
			expect(response.status).toBe(404);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:envelope-not-found');
		});

		it('returns 503 when archive integrity fails', async () => {
			const handlers = createRevisionHttpHandlers(
				createMockResolver({
					listRevisions: async () => {
						throw new DraftIntegrityError('Archive digest mismatch');
					}
				})
			);
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions`,
				locals: locals(),
				params: { envelopeId }
			});

			const response = await handlers.list(event);
			expect(response.status).toBe(503);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:draft-service-unavailable');
		});
	});

	describe('get', () => {
		it('requires envelopes:read authorization', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2`,
				locals: locals('anonymous'),
				params: { envelopeId, revisionRef: '2' }
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(401);
		});

		it('rejects invalid revisionRef', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/invalid_ref!`,
				locals: locals(),
				params: { envelopeId, revisionRef: 'invalid_ref!' }
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:validation-failed');
		});

		it('rejects a generation outside the portable range', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2147483648`,
				locals: locals(),
				params: { envelopeId, revisionRef: '2147483648' }
			});
			expect((await handlers.get(event)).status).toBe(400);
		});

		it('rejects an invalid document path before reading the archive', async () => {
			let resolved = false;
			const handlers = createRevisionHttpHandlers(() => {
				resolved = true;
				return null;
			});
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2`,
				search: '?path=notes.txt',
				locals: locals(),
				params: { envelopeId, revisionRef: '2' }
			});
			const response = await handlers.get(event);
			expect(response.status).toBe(400);
			expect(resolved).toBe(false);
		});

		it('returns exact revision by generation without leaking secrets', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2`,
				locals: locals(),
				params: { envelopeId, revisionRef: '2' }
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as DraftExactRevision;

			expect(body.generation).toBe(2);
			expect(body.commitSha).toBe('2'.repeat(40));
			expect(body.archiveSha256).toBe('a'.repeat(64));
			expect(body.documents).toHaveLength(1);
			expect(body.documentSet?.documents).toHaveLength(1);

			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain('archiveKey');
			expect(serialized).not.toContain('audit_payload_json');
			expect(serialized).not.toContain('email');
			expect(serialized).not.toContain('secret');
		});

		it('returns markdown content when Accept: text/markdown is specified with path', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2`,
				locals: locals(),
				params: { envelopeId, revisionRef: '2' },
				search: '?path=documents/agreement.md',
				headers: { accept: 'text/markdown' }
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/markdown');
			const text = await response.text();
			expect(text).toBe('# Agreement\n\nTerms and conditions.');
		});

		it('returns 404 when document path is not found in revision', async () => {
			const handlers = createRevisionHttpHandlers(
				createMockResolver({
					readRevision: async () => {
						throw new DraftDocumentNotFoundError();
					}
				})
			);
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/2`,
				locals: locals(),
				params: { envelopeId, revisionRef: '2' },
				search: '?path=documents/nonexistent.md'
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(404);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:document-not-found');
		});

		it('returns 404 when revision is not found', async () => {
			const handlers = createRevisionHttpHandlers(
				createMockResolver({
					readRevision: async () => {
						throw new DraftRevisionNotFoundError('Revision 999 not found');
					}
				})
			);
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/999`,
				locals: locals(),
				params: { envelopeId, revisionRef: '999' }
			});

			const response = await handlers.get(event);
			expect(response.status).toBe(404);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:revision-not-found');
		});
	});

	describe('diff', () => {
		it('requires envelopes:read authorization', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/diff`,
				locals: locals('anonymous'),
				params: { envelopeId }
			});

			const response = await handlers.diff(event);
			expect(response.status).toBe(401);
		});

		it('returns structured JSON diff', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/diff`,
				locals: locals(),
				params: { envelopeId },
				search: '?base=1&head=2'
			});

			const response = await handlers.diff(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			const body = (await response.json()) as RevisionDiffResult;

			expect(body.schema).toBe('signkit-revision-diff-v1');
			expect(body.base.generation).toBe(1);
			expect(body.head.generation).toBe(2);
			expect(body.changes).toHaveLength(1);
			expect(body.changes[0].content.unifiedDiff).toContain('+Terms and conditions.');
			expect(body.unifiedText).toContain('+Terms and conditions.');
			expect(body.truncated).toBe(false);

			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain('archiveKey');
			expect(serialized).not.toContain('email');
			expect(serialized).not.toContain('secret');
		});

		it('returns raw unified diff text when format=text is requested', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/diff`,
				locals: locals(),
				params: { envelopeId },
				search: '?base=1&head=2&format=text'
			});

			const response = await handlers.diff(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/plain');
			const text = await response.text();
			expect(text).toContain('--- a/documents/agreement.md');
			expect(text).toContain('+Terms and conditions.');
		});

		it('returns raw unified diff text when Accept: text/plain is sent', async () => {
			const handlers = createRevisionHttpHandlers(createMockResolver());
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/diff`,
				locals: locals(),
				params: { envelopeId },
				headers: { accept: 'text/plain' }
			});

			const response = await handlers.diff(event);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/plain');
			const text = await response.text();
			expect(text).toContain('--- a/documents/agreement.md');
		});

		it('returns 503 when archive integrity fails during diff', async () => {
			const handlers = createRevisionHttpHandlers(
				createMockResolver({
					diffRevisions: async () => {
						throw new DraftIntegrityError('Checksum mismatch');
					}
				})
			);
			const event = createHttpRequestEvent({
				pathname: `/api/v1/envelopes/${envelopeId}/revisions/diff`,
				locals: locals(),
				params: { envelopeId }
			});

			const response = await handlers.diff(event);
			expect(response.status).toBe(503);
			const body = (await response.json()) as { type: string };
			expect(body.type).toBe('urn:signkit:problem:draft-service-unavailable');
		});
	});
});
