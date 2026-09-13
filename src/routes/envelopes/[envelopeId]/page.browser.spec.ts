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

const readyEnvelope = {
	id: ENVELOPE_ID,
	organizationId: 'org-1',
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
	documents: [{ path: 'documents/agreement.md', content: '# Agreement\n' }]
};

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
});
