import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import '../../layout.css';

const { ENVELOPE_ID } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000020'
}));
const SIGNER_ID = '01900000-0000-7000-8000-000000000011';
const APPROVER_ID = '01900000-0000-7000-8000-000000000012';
const REISSUED_AT = '2026-09-26T12:00:00.000Z';

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

vi.mock('$lib/components/pdf-document-view.svelte', async () => ({
	default: (await import('./sent-document-pdf-view-test-stub.svelte')).default
}));

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function problemResponse(type: string, status: number, detail: string): Response {
	return new Response(JSON.stringify({ type, status, title: 'Error', detail }), {
		status,
		headers: { 'content-type': 'application/problem+json' }
	});
}

interface RecipientRow {
	id: string;
	email: string;
	name: string;
	role: 'signer' | 'approver';
	status: 'pending' | 'viewed' | 'completed' | 'declined';
}

function envelopeFixture(status: string) {
	return {
		id: ENVELOPE_ID,
		title: 'Agreement',
		status,
		repositoryGeneration: 1,
		repositoryHead: '0123456789abcdef0123456789abcdef01234567',
		repositoryArchiveSha256: 'a'.repeat(64),
		sentCommitSha: status === 'draft' ? null : '0123456789abcdef0123456789abcdef01234567',
		fieldGeneration: 0,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:00:00.000Z'
	};
}

function detailFixture(status: string, recipients: readonly RecipientRow[]) {
	return {
		envelope: envelopeFixture(status),
		recipients: recipients.map((r) => ({ ...r, locale: 'en' as const, routingOrder: 1 })),
		readyAuditEventId: '01900000-0000-7000-8000-000000000099',
		fields: []
	};
}

interface DeliveryRow {
	recipientId: string;
	role: 'signer' | 'approver';
	status: 'pending' | 'processing' | 'delivered' | 'blocked' | 'failed';
}

function deliveryFixture(status: string, rows: readonly DeliveryRow[]) {
	return {
		delivery: {
			envelopeId: ENVELOPE_ID,
			envelopeStatus: status,
			deliveries: rows.map((row) => ({
				recipientId: row.recipientId,
				recipientRole: row.role,
				routingOrder: 1,
				status: row.status,
				attempts: 1,
				availableAt: null,
				deliveredAt: row.status === 'delivered' ? '2026-09-12T00:00:00.000Z' : null,
				updatedAt: '2026-09-12T00:00:00.000Z',
				errorCode: null
			}))
		}
	};
}

type ReissueHandler = (
	recipientId: string,
	init: RequestInit | undefined
) => Response | Promise<Response>;

function buildFetch(options: {
	status: string;
	recipients: readonly RecipientRow[];
	deliveries?: readonly DeliveryRow[];
	onReissue?: ReissueHandler;
}): {
	fetchMock: ReturnType<typeof vi.fn>;
	calls: Array<{ recipientId: string; init: RequestInit | undefined }>;
} {
	const calls: Array<{ recipientId: string; init: RequestInit | undefined }> = [];
	const fetchMock = vi
		.fn()
		.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
			const urlStr = String(url);
			const reissueMatch = urlStr.match(/\/recipients\/([^/]+)\/reissue$/);
			if (reissueMatch) {
				const recipientId = decodeURIComponent(reissueMatch[1]);
				calls.push({ recipientId, init });
				if (options.onReissue) return options.onReissue(recipientId, init);
				return jsonResponse({
					reissued: { envelopeId: ENVELOPE_ID, recipientId, reissuedAt: REISSUED_AT }
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse(detailFixture(options.status, options.recipients));
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
				return jsonResponse({
					generation: 1,
					commitSha: null,
					archiveSha256: null,
					documents: [],
					documentSet: null
				});
			}
			if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
				return jsonResponse(deliveryFixture(options.status, options.deliveries ?? []));
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`)) {
				return jsonResponse({
					completionArtifact: { envelopeId: ENVELOPE_ID, status: 'pending', pdfStatus: 'pending' }
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`)) {
				return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' } });
			}
			return jsonResponse({});
		});
	return { fetchMock, calls };
}

async function openRecipientsPanel(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', fetchMock);
	const screen = await render(EnvelopePage);
	await expect
		.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
		.toBeVisible();
	await screen.getByRole('tab', { name: 'Recipients' }).click();
	return { screen, panel: screen.getByRole('tabpanel', { name: 'Recipients' }) };
}

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[key];
}

describe('recipient invitation reissue action', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('cancels without posting and describes replacement rather than a signing action in either locale', async () => {
		const name = 'Dana Recipient';
		const { fetchMock, calls } = buildFetch({
			status: 'sent',
			recipients: [
				{ id: SIGNER_ID, email: 'dana@example.com', name, role: 'signer', status: 'pending' }
			],
			deliveries: [{ recipientId: SIGNER_ID, role: 'signer', status: 'delivered' }]
		});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		await panel.getByRole('button', { name: m.envelope_reissue_action_aria({ name }) }).click();
		const dialog = screen.getByRole('alertdialog');
		await expect
			.element(dialog.getByText(m.envelope_reissue_dialog_description({ name })))
			.toBeVisible();
		await dialog.getByRole('button', { name: m.common_cancel() }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(calls).toHaveLength(0);
		for (const locale of ['en', 'ja'] as const) {
			expect(m.envelope_reissue_dialog_description({ name }, { locale })).not.toMatch(
				/signing|署名/
			);
			expect(m.envelope_reissue_success({ name }, { locale })).not.toMatch(
				/email sent|メール送信済み/
			);
		}
	});

	it('has one action per recipient, checks every historical delivery and fails closed for unknown delivery', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			},
			{
				id: APPROVER_ID,
				email: 'alex@example.com',
				name: 'Alex Chen',
				role: 'approver',
				status: 'viewed'
			}
		];
		const { fetchMock } = buildFetch({
			status: 'sent',
			recipients,
			deliveries: [
				{ recipientId: SIGNER_ID, role: 'signer', status: 'delivered' },
				{ recipientId: SIGNER_ID, role: 'signer', status: 'processing' }
			]
		});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		const signer = panel.getByRole('button', {
			name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' })
		});
		expect(signer.elements()).toHaveLength(1);
		await expect.element(signer).toBeDisabled();
		await expect
			.element(panel.getByText(m.envelope_reissue_unavailable_processing()))
			.toBeVisible();
		await expect
			.element(
				panel.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Alex Chen' }) })
			)
			.toBeDisabled();
		await expect.element(panel.getByText(m.envelope_reissue_status_unavailable())).toBeVisible();
		await screen.getByRole('tab', { name: 'Send & status' }).click();
		const statusPanel = screen.getByRole('tabpanel', { name: 'Send & status' });
		expect(statusPanel.getByRole('row').elements()).toHaveLength(3);
		await expect
			.element(statusPanel.getByText(m.envelope_delivery_status_delivered()))
			.toBeVisible();
		await expect
			.element(statusPanel.getByText(m.envelope_delivery_status_processing()))
			.toBeVisible();
	});

	it('labels each eligible row with the role-neutral aria-label, for any recipient role', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			},
			{
				id: APPROVER_ID,
				email: 'alex@example.com',
				name: 'Alex Chen',
				role: 'approver',
				status: 'viewed'
			}
		];
		const { fetchMock } = buildFetch({
			status: 'sent',
			recipients,
			deliveries: recipients.map((r) => ({ recipientId: r.id, role: r.role, status: 'delivered' }))
		});
		const { panel } = await openRecipientsPanel(fetchMock);

		const danaLabel = m.envelope_reissue_action_aria({ name: 'Dana Recipient' });
		const alexLabel = m.envelope_reissue_action_aria({ name: 'Alex Chen' });
		await expect.element(panel.getByRole('button', { name: danaLabel })).toBeEnabled();
		await expect.element(panel.getByRole('button', { name: alexLabel })).toBeEnabled();
		expect(danaLabel).not.toMatch(/signer|approver/i);
		expect(alexLabel).not.toMatch(/signer|approver/i);
	});

	it.each([
		['sent', 'pending', 'delivered', 'enabled'],
		['sent', 'viewed', 'delivered', 'enabled'],
		['sent', 'pending', 'processing', 'disabled'],
		['sent', 'pending', 'blocked', 'disabled'],
		['in_progress', 'viewed', 'delivered', 'enabled'],
		['in_progress', 'pending', 'processing', 'disabled'],
		['sent', 'completed', 'delivered', 'absent'],
		['completed', 'completed', 'delivered', 'absent'],
		['declined', 'declined', 'delivered', 'absent'],
		['voided', 'pending', 'delivered', 'absent'],
		['expired', 'pending', 'delivered', 'absent']
	] as const)(
		'envelope %s + recipient %s + delivery %s -> action is %s',
		async (envelopeStatus, recipientStatus, deliveryStatus, expected) => {
			const recipients: RecipientRow[] = [
				{
					id: SIGNER_ID,
					email: 'dana@example.com',
					name: 'Dana Recipient',
					role: 'signer',
					status: recipientStatus
				}
			];
			const { fetchMock } = buildFetch({
				status: envelopeStatus,
				recipients,
				deliveries: [{ recipientId: SIGNER_ID, role: 'signer', status: deliveryStatus }]
			});
			const { panel } = await openRecipientsPanel(fetchMock);
			const label = m.envelope_reissue_action_aria({ name: 'Dana Recipient' });
			const button = panel.getByRole('button', { name: label });
			if (expected === 'absent') {
				await expect.element(button).not.toBeInTheDocument();
			} else if (expected === 'enabled') {
				await expect.element(button).toBeEnabled();
			} else {
				await expect.element(button).toBeDisabled();
			}
		}
	);

	it('shows no reissue action while the envelope is still a draft', async () => {
		const { fetchMock } = buildFetch({
			status: 'draft',
			recipients: [
				{
					id: SIGNER_ID,
					email: 'dana@example.com',
					name: 'Dana Recipient',
					role: 'signer',
					status: 'pending'
				}
			]
		});
		const { screen } = await openRecipientsPanel(fetchMock);
		const label = m.envelope_reissue_action_aria({ name: 'Dana Recipient' });
		await expect.element(screen.getByRole('button', { name: label })).not.toBeInTheDocument();
	});

	it.each([200, 503])(
		'blocks pending dismissal/double clicks and handles result %s without losing the attempt',
		async (status) => {
			let postAttempts = 0;
			let release: (value: Response) => void = () => undefined;
			const pendingResponse = new Promise<Response>((resolve) => {
				release = resolve;
			});
			const recipients: RecipientRow[] = [
				{
					id: SIGNER_ID,
					email: 'dana@example.com',
					name: 'Dana Recipient',
					role: 'signer',
					status: 'pending'
				}
			];
			const { fetchMock, calls } = buildFetch({
				status: 'sent',
				recipients,
				deliveries: [{ recipientId: SIGNER_ID, role: 'signer', status: 'delivered' }],
				onReissue: (recipientId) =>
					++postAttempts === 1
						? pendingResponse
						: jsonResponse({
								reissued: { envelopeId: ENVELOPE_ID, recipientId, reissuedAt: REISSUED_AT }
							})
			});
			const { screen, panel } = await openRecipientsPanel(fetchMock);
			await panel
				.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' }) })
				.click();
			const dialog = screen.getByRole('alertdialog');
			await expect
				.element(dialog.getByText(m.envelope_reissue_dialog_title({ name: 'Dana Recipient' })))
				.toBeVisible();
			const confirm = dialog.getByRole('button', { name: m.envelope_reissue_dialog_confirm() });
			await confirm.click();
			const confirmButton = confirm.element();
			if (!(confirmButton instanceof HTMLButtonElement))
				throw new Error('Expected native confirmation button');
			confirmButton.click();
			await expect.element(confirm).toBeDisabled();
			await expect.element(dialog.getByRole('button', { name: m.common_cancel() })).toBeDisabled();
			await userEvent.keyboard('{Escape}');
			await expect.element(dialog).toBeVisible();
			expect(calls).toHaveLength(1);
			expect(calls[0].recipientId).toBe(SIGNER_ID);

			const firstKey = headerOf(calls[0].init, 'idempotency-key');
			if (status === 503) {
				release(
					problemResponse('urn:signkit:problem:service-unavailable', 503, 'Temporary failure')
				);
				await expect.element(dialog.getByText(m.envelope_reissue_unavailable())).toBeVisible();
				await dialog.getByRole('button', { name: m.common_cancel() }).click();
				await panel
					.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' }) })
					.click();
				await screen
					.getByRole('alertdialog')
					.getByRole('button', { name: m.envelope_reissue_dialog_confirm() })
					.click();
			} else {
				release(
					jsonResponse({
						reissued: { envelopeId: ENVELOPE_ID, recipientId: SIGNER_ID, reissuedAt: REISSUED_AT }
					})
				);
			}
			await expect
				.element(panel.getByText(m.envelope_reissue_success({ name: 'Dana Recipient' })))
				.toBeVisible();
			expect(calls).toHaveLength(status === 503 ? 2 : 1);
			expect(headerOf(calls.at(-1)?.init, 'idempotency-key')).toBe(firstKey);
			expect(headerOf(calls[0].init, 'idempotency-key')).toBeTruthy();
			expect(calls[0].init?.method).toBe('POST');
			expect(calls[0].init?.body).toBe('{}');
		}
	);

	it('retains one Idempotency-Key across an ambiguous failure, cancel and reopen; a different recipient gets its own key; success then clears it', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			},
			{
				id: APPROVER_ID,
				email: 'alex@example.com',
				name: 'Alex Chen',
				role: 'approver',
				status: 'viewed'
			}
		];
		let danaAttempts = 0;
		const { fetchMock, calls } = buildFetch({
			status: 'sent',
			recipients,
			deliveries: recipients.map((r) => ({ recipientId: r.id, role: r.role, status: 'delivered' })),
			onReissue: (recipientId) => {
				if (recipientId === SIGNER_ID) {
					danaAttempts += 1;
					if (danaAttempts < 3) {
						return problemResponse(
							'urn:signkit:problem:service-unavailable',
							503,
							'Try again shortly.'
						);
					}
				}
				return jsonResponse({
					reissued: { envelopeId: ENVELOPE_ID, recipientId, reissuedAt: REISSUED_AT }
				});
			}
		});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		const danaLabel = m.envelope_reissue_action_aria({ name: 'Dana Recipient' });
		const alexLabel = m.envelope_reissue_action_aria({ name: 'Alex Chen' });
		const confirmLabel = m.envelope_reissue_dialog_confirm();

		await panel.getByRole('button', { name: danaLabel }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_unavailable()))
			.toBeVisible();
		const firstKey = headerOf(calls[0].init, 'idempotency-key');
		expect(firstKey).toBeTruthy();

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel.getByRole('button', { name: danaLabel }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_unavailable()))
			.toBeVisible();
		expect(headerOf(calls[1].init, 'idempotency-key')).toBe(firstKey);

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel.getByRole('button', { name: alexLabel }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(panel.getByText(m.envelope_reissue_success({ name: 'Alex Chen' })))
			.toBeVisible();
		expect(headerOf(calls[2].init, 'idempotency-key')).not.toBe(firstKey);

		await panel.getByRole('button', { name: danaLabel }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		expect(headerOf(calls[3].init, 'idempotency-key')).toBe(firstKey);
		await expect
			.element(panel.getByText(m.envelope_reissue_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		expect(calls.map((call) => call.recipientId)).toEqual([
			SIGNER_ID,
			SIGNER_ID,
			APPROVER_ID,
			SIGNER_ID
		]);
		await panel.getByRole('button', { name: danaLabel }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(panel.getByText(m.envelope_reissue_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		expect(headerOf(calls[4].init, 'idempotency-key')).not.toBe(firstKey);
	});

	it('treats 403 as an authoritative rejection: localizes it and mints a fresh key on the next attempt', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			}
		];
		let attempts = 0;
		const { fetchMock, calls } = buildFetch({
			status: 'sent',
			recipients,
			deliveries: [{ recipientId: SIGNER_ID, role: 'signer', status: 'delivered' }],
			onReissue: (recipientId) => {
				attempts += 1;
				if (attempts === 1) {
					return problemResponse(
						'urn:signkit:problem:recipient-reissue-forbidden',
						403,
						'You are not authorized to reissue this invitation.'
					);
				}
				return jsonResponse({
					reissued: { envelopeId: ENVELOPE_ID, recipientId, reissuedAt: REISSUED_AT }
				});
			}
		});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		const label = m.envelope_reissue_action_aria({ name: 'Dana Recipient' });
		const confirmLabel = m.envelope_reissue_dialog_confirm();

		await panel.getByRole('button', { name: label }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_forbidden()))
			.toBeVisible();
		const firstKey = headerOf(calls[0].init, 'idempotency-key');

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel.getByRole('button', { name: label }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		expect(headerOf(calls[1].init, 'idempotency-key')).not.toBe(firstKey);
		await expect
			.element(panel.getByText(m.envelope_reissue_success({ name: 'Dana Recipient' })))
			.toBeVisible();
	});

	it('does not conflate 409s: only the exact delivery-in-flight type claims delivery is in flight', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			},
			{
				id: APPROVER_ID,
				email: 'alex@example.com',
				name: 'Alex Chen',
				role: 'approver',
				status: 'viewed'
			}
		];
		const inFlightDetail =
			"This recipient's invitation is already being delivered. Try again shortly.";
		const otherConflictDetail =
			'This recipient has already completed their part of this agreement.';
		const { fetchMock } = buildFetch({
			status: 'sent',
			recipients,
			deliveries: recipients.map((r) => ({ recipientId: r.id, role: r.role, status: 'delivered' })),
			onReissue: (recipientId) =>
				recipientId === SIGNER_ID
					? problemResponse('urn:signkit:problem:delivery-in-flight', 409, inFlightDetail)
					: problemResponse(
							'urn:signkit:problem:recipient-status-conflict',
							409,
							otherConflictDetail
						)
		});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		const confirmLabel = m.envelope_reissue_dialog_confirm();

		await panel
			.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' }) })
			.click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_delivery_in_flight()))
			.toBeVisible();

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel
			.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Alex Chen' }) })
			.click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_conflict()))
			.toBeVisible();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_reissue_delivery_in_flight()))
			.not.toBeInTheDocument();
		expect(otherConflictDetail).not.toMatch(/deliver/i);
	});

	it('reports success even when the post-success reload fails, showing both texts distinctly', async () => {
		const recipients: RecipientRow[] = [
			{
				id: SIGNER_ID,
				email: 'dana@example.com',
				name: 'Dana Recipient',
				role: 'signer',
				status: 'pending'
			}
		];
		let detailCalls = 0;
		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.match(/\/recipients\/[^/]+\/reissue$/)) {
					return jsonResponse({
						reissued: { envelopeId: ENVELOPE_ID, recipientId: SIGNER_ID, reissuedAt: REISSUED_AT }
					});
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					detailCalls += 1;
					if (detailCalls > 1) throw new TypeError('network unavailable');
					return jsonResponse(detailFixture('sent', recipients));
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return new Response(null, { status: 404 });
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse(
						deliveryFixture('sent', [
							{ recipientId: SIGNER_ID, role: 'signer', status: 'delivered' }
						])
					);
				}
				return jsonResponse({});
			});
		const { screen, panel } = await openRecipientsPanel(fetchMock);
		await panel
			.getByRole('button', { name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' }) })
			.click();
		await screen
			.getByRole('alertdialog')
			.getByRole('button', { name: m.envelope_reissue_dialog_confirm() })
			.click();

		await expect
			.element(panel.getByText(m.envelope_reissue_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		await expect.element(panel.getByText(m.envelope_reissue_refresh_failed())).toBeVisible();
		await expect
			.element(
				panel.getByRole('button', {
					name: m.envelope_reissue_action_aria({ name: 'Dana Recipient' })
				})
			)
			.toBeDisabled();
	});
});
