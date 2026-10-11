import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import EnvelopePage from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import '../../layout.css';

const { ENVELOPE_ID } = vi.hoisted(() => ({
	ENVELOPE_ID: '01900000-0000-7000-8000-000000000030'
}));
const SIGNER_ID = '01900000-0000-7000-8000-000000000031';
const APPROVER_ID = '01900000-0000-7000-8000-000000000032';
const PREDECESSOR_DELIVERY_ID = '01900000-0000-7000-8000-000000000041';
const NEW_DELIVERY_ID = '01900000-0000-7000-8000-000000000042';
const FAILED_AT = '2026-10-10T00:00:00.000Z';
const ERROR_CODE = 'completion_delivery_attempts_exhausted';
const REISSUED_AT = '2026-10-11T12:00:00.000Z';
const NEW_ACCESS_EXPIRES_AT = '2026-11-10T12:00:00.000Z';

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
}

function detailFixture(recipients: readonly RecipientRow[]) {
	return {
		envelope: {
			id: ENVELOPE_ID,
			title: 'Agreement',
			status: 'completed',
			repositoryGeneration: 1,
			repositoryHead: '0123456789abcdef0123456789abcdef01234567',
			repositoryArchiveSha256: 'a'.repeat(64),
			sentCommitSha: '0123456789abcdef0123456789abcdef01234567',
			fieldGeneration: 0,
			createdAt: '2026-09-11T00:00:00.000Z',
			updatedAt: '2026-09-11T00:00:00.000Z'
		},
		recipients: recipients.map((r) => ({
			...r,
			role: r.role,
			locale: 'en' as const,
			routingOrder: 1,
			status: 'completed' as const
		})),
		readyAuditEventId: '01900000-0000-7000-8000-000000000099',
		fields: []
	};
}

interface CompletionDeliveryRow {
	deliveryId: string;
	recipientId: string;
	recipientRole: 'signer' | 'approver';
	generation: number;
	status: 'pending' | 'processing' | 'delivered' | 'failed';
	attempts: number;
	accessExpiresAt: string;
	accessRevokedAt: string | null;
	deliveredAt: string | null;
	failedAt: string | null;
	errorCode: string | null;
	failureCauseCode: string | null;
	eligibleForReissue: boolean;
}

function exhaustedRow(
	recipientId: string,
	role: 'signer' | 'approver',
	overrides: Partial<CompletionDeliveryRow> = {}
): CompletionDeliveryRow {
	return {
		deliveryId:
			recipientId === SIGNER_ID ? PREDECESSOR_DELIVERY_ID : `${PREDECESSOR_DELIVERY_ID}-2`,
		recipientId,
		recipientRole: role,
		generation: 0,
		status: 'failed',
		attempts: 10,
		accessExpiresAt: '2026-10-10T00:00:00.000Z',
		accessRevokedAt: FAILED_AT,
		deliveredAt: null,
		failedAt: FAILED_AT,
		errorCode: ERROR_CODE,
		failureCauseCode: 'mail_delivery_failed',
		eligibleForReissue: true,
		...overrides
	};
}

type ReissueHandler = (
	recipientId: string,
	init: RequestInit | undefined
) => Response | Promise<Response>;

function buildFetch(options: {
	recipients: readonly RecipientRow[];
	deliveries: readonly CompletionDeliveryRow[];
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
			const reissueMatch = urlStr.match(/\/recipients\/([^/]+)\/completion-access\/reissue$/);
			if (reissueMatch) {
				const recipientId = decodeURIComponent(reissueMatch[1]);
				calls.push({ recipientId, init });
				if (options.onReissue) return options.onReissue(recipientId, init);
				return jsonResponse({
					completionAccessReissue: {
						envelopeId: ENVELOPE_ID,
						recipientId,
						deliveryId: NEW_DELIVERY_ID,
						generation: 1,
						accessExpiresAt: NEW_ACCESS_EXPIRES_AT,
						reissuedAt: REISSUED_AT
					}
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
				return jsonResponse(detailFixture(options.recipients));
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
				return jsonResponse({
					delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'completed', deliveries: [] }
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`)) {
				return jsonResponse({
					completionArtifact: { envelopeId: ENVELOPE_ID, status: 'pending', attempts: 0 }
				});
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`)) {
				return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' } });
			}
			if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-deliveries`)) {
				return jsonResponse({ completionDeliveries: options.deliveries });
			}
			return jsonResponse({});
		});
	return { fetchMock, calls };
}

async function openDocumentsTab(fetchMock: ReturnType<typeof vi.fn>) {
	vi.stubGlobal('fetch', fetchMock);
	const screen = await render(EnvelopePage);
	await expect
		.element(screen.getByRole('heading', { name: 'Agreement', level: 1 }).first())
		.toBeVisible();
	const panel = screen.getByRole('tabpanel', { name: 'Documents' });
	return { screen, panel };
}

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[key];
}

describe('completion access reissue action', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('cancels without posting and describes a fresh 30-day grant with the old link staying revoked', async () => {
		const name = 'Dana Recipient';
		const { fetchMock, calls } = buildFetch({
			recipients: [{ id: SIGNER_ID, email: 'dana@example.com', name, role: 'signer' }],
			deliveries: [exhaustedRow(SIGNER_ID, 'signer')]
		});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		await panel
			.getByRole('button', { name: m.envelope_completion_access_action_aria({ name }) })
			.click();
		const dialog = screen.getByRole('alertdialog');
		await expect
			.element(dialog.getByText(m.envelope_completion_access_dialog_description()))
			.toBeVisible();
		await dialog.getByRole('button', { name: m.common_cancel() }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(calls).toHaveLength(0);
		for (const locale of ['en', 'ja'] as const) {
			expect(m.envelope_completion_access_dialog_description({}, { locale })).toMatch(
				/30|revoked|無効/
			);
			expect(m.envelope_completion_access_success({ name }, { locale })).not.toMatch(
				/delivered|配送済み/
			);
		}
	});

	it.each([
		['failed', true, 'enabled'],
		['failed', false, 'disabled'],
		['pending', true, 'absent'],
		['processing', true, 'absent'],
		['delivered', true, 'absent']
	] as const)(
		'status %s + eligibleForReissue %s -> action is %s',
		async (status, eligibleForReissue, expected) => {
			const { fetchMock } = buildFetch({
				recipients: [
					{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
				],
				deliveries: [
					exhaustedRow(SIGNER_ID, 'signer', {
						status,
						eligibleForReissue,
						deliveredAt: status === 'delivered' ? REISSUED_AT : null
					})
				]
			});
			const { panel } = await openDocumentsTab(fetchMock);
			const label = m.envelope_completion_access_action_aria({ name: 'Dana Recipient' });
			const button = panel.getByRole('button', { name: label });
			if (expected === 'absent') {
				await expect.element(button).not.toBeInTheDocument();
			} else if (expected === 'enabled') {
				await expect.element(button).toBeEnabled();
			} else {
				await expect.element(button).toBeDisabled();
				await expect
					.element(panel.getByText(m.envelope_completion_access_still_retrying()))
					.toBeVisible();
			}
		}
	);

	it.each(['mail_delivery_failed', null] as const)(
		'shows the recorded failure cause %s without inferring a historical cause from exhaustion',
		async (failureCauseCode) => {
			const { fetchMock } = buildFetch({
				recipients: [
					{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
				],
				deliveries: [exhaustedRow(SIGNER_ID, 'signer', { failureCauseCode })]
			});
			const { panel } = await openDocumentsTab(fetchMock);
			const label =
				failureCauseCode === null
					? m.envelope_completion_access_cause_unknown()
					: m.envelope_completion_access_cause({ code: failureCauseCode });
			await expect.element(panel.getByText(label)).toBeVisible();
		}
	);

	it('reports acceptance/queueing rather than delivery, and the old grant is never re-posted', async () => {
		const { fetchMock, calls } = buildFetch({
			recipients: [
				{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
			],
			deliveries: [exhaustedRow(SIGNER_ID, 'signer')]
		});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		await panel
			.getByRole('button', {
				name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
			})
			.click();
		await screen
			.getByRole('alertdialog')
			.getByRole('button', { name: m.envelope_completion_access_dialog_confirm() })
			.click();
		await expect
			.element(panel.getByText(m.envelope_completion_access_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		expect(calls).toHaveLength(1);
		const body = JSON.parse((calls[0].init?.body as string) ?? '{}');
		expect(body).toEqual({
			grantAccess: true,
			expectedDeliveryId: PREDECESSOR_DELIVERY_ID,
			expectedAttempts: 10,
			expectedFailedAt: FAILED_AT,
			expectedErrorCode: ERROR_CODE
		});
	});

	it.each([200, 503])(
		'blocks pending dismissal/double clicks and handles result %s without losing the attempt',
		async (status) => {
			let postAttempts = 0;
			let release: (value: Response) => void = () => undefined;
			const pendingResponse = new Promise<Response>((resolve) => {
				release = resolve;
			});
			const { fetchMock, calls } = buildFetch({
				recipients: [
					{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
				],
				deliveries: [exhaustedRow(SIGNER_ID, 'signer')],
				onReissue: (recipientId) =>
					++postAttempts === 1
						? pendingResponse
						: jsonResponse({
								completionAccessReissue: {
									envelopeId: ENVELOPE_ID,
									recipientId,
									deliveryId: NEW_DELIVERY_ID,
									generation: 1,
									accessExpiresAt: NEW_ACCESS_EXPIRES_AT,
									reissuedAt: REISSUED_AT
								}
							})
			});
			const { screen, panel } = await openDocumentsTab(fetchMock);
			await panel
				.getByRole('button', {
					name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
				})
				.click();
			const dialog = screen.getByRole('alertdialog');
			const confirm = dialog.getByRole('button', {
				name: m.envelope_completion_access_dialog_confirm()
			});
			const confirmButton = confirm.element();
			if (!(confirmButton instanceof HTMLButtonElement))
				throw new Error('Expected native confirmation button');
			confirmButton.click();
			await expect.element(confirm).toBeDisabled();
			await expect.element(dialog.getByRole('button', { name: m.common_cancel() })).toBeDisabled();
			await userEvent.keyboard('{Escape}');
			await expect.element(dialog).toBeVisible();
			confirmButton.click();
			expect(calls).toHaveLength(1);

			const firstKey = headerOf(calls[0].init, 'idempotency-key');
			if (status === 503) {
				release(problemResponse('urn:signkit:problem:http-503', 503, 'Temporary failure'));
				await expect
					.element(dialog.getByText(m.envelope_completion_access_unavailable_action()))
					.toBeVisible();
				await dialog.getByRole('button', { name: m.common_cancel() }).click();
				await panel
					.getByRole('button', {
						name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
					})
					.click();
				await screen
					.getByRole('alertdialog')
					.getByRole('button', { name: m.envelope_completion_access_dialog_confirm() })
					.click();
			} else {
				release(
					jsonResponse({
						completionAccessReissue: {
							envelopeId: ENVELOPE_ID,
							recipientId: SIGNER_ID,
							deliveryId: NEW_DELIVERY_ID,
							generation: 1,
							accessExpiresAt: NEW_ACCESS_EXPIRES_AT,
							reissuedAt: REISSUED_AT
						}
					})
				);
			}
			await expect
				.element(panel.getByText(m.envelope_completion_access_success({ name: 'Dana Recipient' })))
				.toBeVisible();
			expect(calls).toHaveLength(status === 503 ? 2 : 1);
			expect(headerOf(calls.at(-1)?.init, 'idempotency-key')).toBe(firstKey);
			expect(headerOf(calls[0].init, 'idempotency-key')).toBeTruthy();
			expect(calls[0].init?.method).toBe('POST');
		}
	);

	it('retains one Idempotency-Key and the same CAS tuple across an ambiguous failure, cancel and reopen; success then clears it', async () => {
		let attempts = 0;
		const { fetchMock, calls } = buildFetch({
			recipients: [
				{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
			],
			deliveries: [exhaustedRow(SIGNER_ID, 'signer')],
			onReissue: (recipientId) => {
				attempts += 1;
				if (attempts < 3) {
					return problemResponse('urn:signkit:problem:http-503', 503, 'Try again shortly.');
				}
				return jsonResponse({
					completionAccessReissue: {
						envelopeId: ENVELOPE_ID,
						recipientId,
						deliveryId: NEW_DELIVERY_ID,
						generation: 1,
						accessExpiresAt: NEW_ACCESS_EXPIRES_AT,
						reissuedAt: REISSUED_AT
					}
				});
			}
		});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		const label = m.envelope_completion_access_action_aria({ name: 'Dana Recipient' });
		const confirmLabel = m.envelope_completion_access_dialog_confirm();

		await panel.getByRole('button', { name: label }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(
				screen.getByRole('alertdialog').getByText(m.envelope_completion_access_unavailable_action())
			)
			.toBeVisible();
		const firstKey = headerOf(calls[0].init, 'idempotency-key');
		const firstBody = calls[0].init?.body as string;
		expect(firstKey).toBeTruthy();

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel.getByRole('button', { name: label }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(
				screen.getByRole('alertdialog').getByText(m.envelope_completion_access_unavailable_action())
			)
			.toBeVisible();
		expect(headerOf(calls[1].init, 'idempotency-key')).toBe(firstKey);
		expect(calls[1].init?.body).toBe(firstBody);

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel.getByRole('button', { name: label }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(panel.getByText(m.envelope_completion_access_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		expect(headerOf(calls[2].init, 'idempotency-key')).toBe(firstKey);
		expect(calls[2].init?.body).toBe(firstBody);
	});

	it('does not conflate 409s: not-eligible, stale-generation and idempotency-conflict each get their own message', async () => {
		const { fetchMock } = buildFetch({
			recipients: [
				{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' },
				{ id: APPROVER_ID, email: 'alex@example.com', name: 'Alex Chen', role: 'approver' }
			],
			deliveries: [exhaustedRow(SIGNER_ID, 'signer'), exhaustedRow(APPROVER_ID, 'approver')],
			onReissue: (recipientId) =>
				recipientId === SIGNER_ID
					? problemResponse(
							'urn:signkit:problem:completion-access-reissue-stale-generation',
							409,
							'The expected delivery generation has moved on.'
						)
					: problemResponse(
							'urn:signkit:problem:idempotency-key-conflict',
							409,
							'The provided Idempotency-Key was previously used with different command parameters.'
						)
		});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		const confirmLabel = m.envelope_completion_access_dialog_confirm();

		await panel
			.getByRole('button', {
				name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
			})
			.click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_completion_access_stale()))
			.toBeVisible();

		await screen.getByRole('alertdialog').getByRole('button', { name: m.common_cancel() }).click();
		await panel
			.getByRole('button', {
				name: m.envelope_completion_access_action_aria({ name: 'Alex Chen' })
			})
			.click();
		await screen.getByRole('alertdialog').getByRole('button', { name: confirmLabel }).click();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_completion_access_conflict()))
			.toBeVisible();
		await expect
			.element(screen.getByRole('alertdialog').getByText(m.envelope_completion_access_stale()))
			.not.toBeInTheDocument();
	});

	it('reports a dedicated message when the completion manifest/PDF are not published yet', async () => {
		const { fetchMock } = buildFetch({
			recipients: [
				{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
			],
			deliveries: [exhaustedRow(SIGNER_ID, 'signer')],
			onReissue: () =>
				problemResponse(
					'urn:signkit:problem:completion-access-reissue-artifact-unavailable',
					409,
					'The completion manifest and PDF must be published before access can be reissued.'
				)
		});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		await panel
			.getByRole('button', {
				name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
			})
			.click();
		await screen
			.getByRole('alertdialog')
			.getByRole('button', { name: m.envelope_completion_access_dialog_confirm() })
			.click();
		await expect
			.element(
				screen
					.getByRole('alertdialog')
					.getByText(m.envelope_completion_access_artifact_unavailable())
			)
			.toBeVisible();
	});

	it('reports success even when the post-success refresh fails, showing both texts distinctly', async () => {
		const recipients: RecipientRow[] = [
			{ id: SIGNER_ID, email: 'dana@example.com', name: 'Dana Recipient', role: 'signer' }
		];
		let completionDeliveriesCalls = 0;
		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.match(/\/recipients\/[^/]+\/completion-access\/reissue$/)) {
					return jsonResponse({
						completionAccessReissue: {
							envelopeId: ENVELOPE_ID,
							recipientId: SIGNER_ID,
							deliveryId: NEW_DELIVERY_ID,
							generation: 1,
							accessExpiresAt: NEW_ACCESS_EXPIRES_AT,
							reissuedAt: REISSUED_AT
						}
					});
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}`) && init?.method !== 'POST') {
					return jsonResponse(detailFixture(recipients));
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/draft`)) {
					return new Response(null, { status: 404 });
				}
				if (urlStr.includes(`/api/v1/envelopes/${ENVELOPE_ID}/deliveries`)) {
					return jsonResponse({
						delivery: { envelopeId: ENVELOPE_ID, envelopeStatus: 'completed', deliveries: [] }
					});
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-artifact`)) {
					return jsonResponse({
						completionArtifact: { envelopeId: ENVELOPE_ID, status: 'pending', attempts: 0 }
					});
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/pdf-seal`)) {
					return jsonResponse({ pdfSeal: { envelopeId: ENVELOPE_ID, status: 'disabled' } });
				}
				if (urlStr.endsWith(`/api/v1/envelopes/${ENVELOPE_ID}/completion-deliveries`)) {
					completionDeliveriesCalls += 1;
					if (completionDeliveriesCalls > 1) throw new TypeError('network unavailable');
					return jsonResponse({ completionDeliveries: [exhaustedRow(SIGNER_ID, 'signer')] });
				}
				return jsonResponse({});
			});
		const { screen, panel } = await openDocumentsTab(fetchMock);
		await panel
			.getByRole('button', {
				name: m.envelope_completion_access_action_aria({ name: 'Dana Recipient' })
			})
			.click();
		await screen
			.getByRole('alertdialog')
			.getByRole('button', { name: m.envelope_completion_access_dialog_confirm() })
			.click();

		await expect
			.element(panel.getByText(m.envelope_completion_access_success({ name: 'Dana Recipient' })))
			.toBeVisible();
		await expect
			.element(panel.getByText(m.envelope_completion_access_refresh_failed()))
			.toBeVisible();
	});
});
