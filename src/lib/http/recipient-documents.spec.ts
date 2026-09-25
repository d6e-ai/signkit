import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipientWorkspace,
	RecipientWorkspaceApplicationPort
} from '$lib/application/signing/recipient-workspace';
import { RecipientWorkspaceIntegrityError } from '$lib/application/signing/recipient-workspace';
import {
	createRecipientDocumentsHandler,
	type RecipientWorkspaceApplicationResolver
} from './recipient-documents';

const token: string = `skr1_${'A'.repeat(43)}`;
const workspace: RecipientWorkspace = {
	access: {
		envelopeId: 'env-1',
		recipientId: 'recipient-1',
		recipientName: 'Alex Rivera',
		role: 'signer',
		locale: 'ja',
		recipientStatus: 'pending',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'sent',
		expiresAt: '2026-09-12T00:00:00.000Z'
	},
	documents: [
		{
			documentId: 'legacy',
			position: 0,
			title: 'agreement',
			kind: 'legacy',
			pageCount: 2,
			pageWidth: 595.28,
			pageHeight: 841.89
		}
	],
	source: 'legacy' as const,
	fields: [
		{
			id: 'field-1',
			documentId: 'legacy',
			fieldType: 'signature',
			label: 'Your signature',
			required: true,
			geometry: { page: 1, x: 0.1, y: 0.1, width: 0.25, height: 0.05 }
		}
	],
	fieldGeneration: 1
};

function event(authorization?: string): RequestEvent {
	const headers: Headers = new Headers();
	if (authorization !== undefined) headers.set('authorization', authorization);
	return {
		request: new Request('https://signkit.example/api/v1/signing/documents', { headers }),
		platform: { env: { DB: {} as D1Database, OBJECTS: {} as R2Bucket } },
		url: new URL('https://signkit.example/api/v1/signing/documents')
	} as unknown as RequestEvent;
}

function application(
	result: RecipientWorkspace | null = workspace
): RecipientWorkspaceApplicationPort {
	return { resolve: vi.fn(async (): Promise<RecipientWorkspace | null> => result) };
}

describe('recipient documents HTTP handler', () => {
	it('rejects a browser Origin on the CLI document-discovery surface', async () => {
		const app: RecipientWorkspaceApplicationPort = application();
		const requestEvent: RequestEvent = event(`Bearer ${token}`);
		requestEvent.request.headers.set('origin', 'https://signkit.example');
		const response: Response = await createRecipientDocumentsHandler(
			() => app,
			undefined,
			'bearer'
		)(requestEvent);
		expect(response.status).toBe(404);
		expect(app.resolve).not.toHaveBeenCalled();
	});

	it.each([undefined, 'Bearer malformed', `${`Bearer ${token}`}, Basic extra`])(
		'rejects missing or malformed authorization without resolving storage',
		async (authorization) => {
			const resolver: RecipientWorkspaceApplicationResolver = vi.fn(() => application());
			const response: Response = await createRecipientDocumentsHandler(resolver)(
				event(authorization)
			);
			expect(response.status).toBe(404);
			expect(resolver).not.toHaveBeenCalled();
		}
	);

	it('returns allowlisted access and page geometry, never Markdown or storage internals', async () => {
		const app: RecipientWorkspaceApplicationPort = application();
		const response: Response = await createRecipientDocumentsHandler(
			() => app,
			() => new Date('2026-09-11T00:00:00.000Z')
		)(event(`Bearer ${token}`));
		const body: unknown = await response.json();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('vary')).toBe('Authorization');
		expect(app.resolve).toHaveBeenCalledWith(token, '2026-09-11T00:00:00.000Z');
		expect(body).toEqual({
			access: workspace.access,
			documents: workspace.documents,
			source: workspace.source
		});
		const serialized: string = JSON.stringify(body);
		expect(serialized).not.toMatch(
			/organization|archiveKey|archiveSha256|skr1_|Your signature|fieldGeneration|field-1/
		);
		// The agreement text itself is never part of a JSON response: recipients
		// read the pinned PDF from a capability-authorized endpoint instead.
		expect(serialized).not.toMatch(/# Agreement|documents\/|\.md/);
	});

	it('returns only the recipient-owned fields on the bearer CLI surface', async () => {
		const response: Response = await createRecipientDocumentsHandler(
			() => application(),
			undefined,
			'bearer'
		)(event(`Bearer ${token}`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			access: workspace.access,
			documents: workspace.documents,
			source: workspace.source,
			fields: workspace.fields,
			fieldGeneration: workspace.fieldGeneration
		});
	});

	it.each([
		['missing runtime', null],
		['inactive access', application(null)]
	] as const)('maps %s without leaking details', async (_name, resolved) => {
		const response: Response = await createRecipientDocumentsHandler(() => resolved)(
			event(`Bearer ${token}`)
		);
		expect(response.status).toBe(resolved === null ? 503 : 404);
	});

	it('maps archive failures to a fixed unavailable problem and log event', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createRecipientDocumentsHandler(() => ({
			resolve: async (): Promise<RecipientWorkspace> => {
				throw new Error('private/object/key.git.gz');
			}
		}))(event(`Bearer ${token}`));
		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain('private/object');
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'recipient_documents_failed' }));
		error.mockRestore();
	});

	it('emits a distinct secret-free event for integrity failures', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
		const response: Response = await createRecipientDocumentsHandler(() => ({
			resolve: async (): Promise<RecipientWorkspace> => {
				throw new RecipientWorkspaceIntegrityError();
			}
		}))(event(`Bearer ${token}`));
		expect(response.status).toBe(503);
		expect(error).toHaveBeenCalledWith(
			JSON.stringify({ event: 'recipient_documents_integrity_failed' })
		);
		error.mockRestore();
	});
});
