import { describe, expect, it } from 'vitest';
import type { Recipient } from '$lib/domain/envelope';
import {
	canonicalReadyRequestJson,
	canonicalizeReadyRecipients,
	fingerprintReadyRequest,
	readyAuditPayloadJson,
	validStoredReadyReceipt
} from './ready';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const SIGNER_ID: string = '01900000-0000-7000-8000-000000000011';
const VIEWER_ID: string = '01900000-0000-7000-8000-000000000012';

const GOLDEN_REQUEST_JSON: string =
	'{"expectedGeneration":2,"recipients":[{"email":"a@example.com","name":"Alice","role":"signer","locale":"ja","routingOrder":1},{"email":"b@example.com","name":"Bob","role":"viewer","locale":"en","routingOrder":1}]}';
const GOLDEN_REQUEST_FINGERPRINT: string =
	'a0d2aa87421965381dde60394b9d69ff990315623848326eb99b77e291b7925e';
const GOLDEN_AUDIT_JSON: string =
	'{"commitSha":"0123456789abcdef0123456789abcdef01234567","generation":2,"recipients":[{"id":"01900000-0000-7000-8000-000000000011","role":"signer","routingOrder":1},{"id":"01900000-0000-7000-8000-000000000012","role":"viewer","routingOrder":1}]}';
const TAMPERED_NAME_FINGERPRINT: string =
	'74226e3ff2397fe80656aaad1aef587edc74a01890501e3506a9dae937045db5';
const UNORDERED_REQUEST_FINGERPRINT: string =
	'f0d5d4659c3a0b75e66d7a45fe76e22cd7c2916d076c7806b020e71d26f2f424';

const storedRecipients: readonly Recipient[] = [
	{
		id: SIGNER_ID,
		envelopeId: ENVELOPE_ID,
		email: 'a@example.com',
		name: 'Alice',
		role: 'signer',
		locale: 'ja',
		routingOrder: 1,
		status: 'pending'
	},
	{
		id: VIEWER_ID,
		envelopeId: ENVELOPE_ID,
		email: 'b@example.com',
		name: 'Bob',
		role: 'viewer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending'
	}
];

describe('ready command contract', () => {
	it('emits the frozen canonical request bytes and fingerprint', async () => {
		const canonical = canonicalizeReadyRecipients([
			{ email: ' B@example.com ', name: ' Bob ', role: 'viewer', locale: 'en', routingOrder: 1 },
			{ email: 'A@Example.com', name: ' Alice ', role: 'signer', locale: 'ja', routingOrder: 1 }
		]);
		const requestJson: string = canonicalReadyRequestJson({
			expectedGeneration: 2,
			recipients: canonical
		});
		expect(requestJson).toBe(GOLDEN_REQUEST_JSON);
		expect(await fingerprintReadyRequest({ expectedGeneration: 2, recipients: canonical })).toBe(
			GOLDEN_REQUEST_FINGERPRINT
		);
	});

	it('keeps recipient identity out of the ready audit payload bytes', () => {
		const auditJson: string = readyAuditPayloadJson({
			commitSha: COMMIT_SHA,
			generation: 2,
			recipients: [
				{ id: SIGNER_ID, role: 'signer', routingOrder: 1 },
				{ id: VIEWER_ID, role: 'viewer', routingOrder: 1 }
			]
		});
		expect(auditJson).toBe(GOLDEN_AUDIT_JSON);
		expect(auditJson).not.toContain('@example.com');
		expect(auditJson).not.toContain('Alice');
	});

	it('does not re-sort stored recipient order when reconstructing a receipt', async () => {
		const unorderedJson: string = canonicalReadyRequestJson({
			expectedGeneration: 2,
			recipients: [
				{
					email: 'b@example.com',
					name: 'Bob',
					role: 'viewer',
					locale: 'en',
					routingOrder: 1
				},
				{
					email: 'a@example.com',
					name: 'Alice',
					role: 'signer',
					locale: 'ja',
					routingOrder: 1
				}
			]
		});
		expect(
			await fingerprintReadyRequest({
				expectedGeneration: 2,
				recipients: [
					{
						email: 'b@example.com',
						name: 'Bob',
						role: 'viewer',
						locale: 'en',
						routingOrder: 1
					},
					{
						email: 'a@example.com',
						name: 'Alice',
						role: 'signer',
						locale: 'ja',
						routingOrder: 1
					}
				]
			})
		).toBe(UNORDERED_REQUEST_FINGERPRINT);
		expect(unorderedJson).not.toBe(GOLDEN_REQUEST_JSON);
	});

	it('accepts a stored receipt whose fingerprint and audit bytes still match', async () => {
		await expect(
			validStoredReadyReceipt(
				{
					envelopeId: ENVELOPE_ID,
					expectedGeneration: 2,
					commitSha: COMMIT_SHA,
					requestHash: GOLDEN_REQUEST_FINGERPRINT,
					auditPayloadJson: GOLDEN_AUDIT_JSON
				},
				storedRecipients
			)
		).resolves.toBe(true);
	});

	it('rejects a tampered recipient name even when the stored hash is left unchanged', async () => {
		const tampered: readonly Recipient[] = [
			{ ...storedRecipients[0], name: 'Mallory' },
			storedRecipients[1]
		];
		await expect(
			validStoredReadyReceipt(
				{
					envelopeId: ENVELOPE_ID,
					expectedGeneration: 2,
					commitSha: COMMIT_SHA,
					requestHash: GOLDEN_REQUEST_FINGERPRINT,
					auditPayloadJson: GOLDEN_AUDIT_JSON
				},
				tampered
			)
		).resolves.toBe(false);
		expect(
			await fingerprintReadyRequest({
				expectedGeneration: 2,
				recipients: tampered.map((recipient: Recipient) => ({
					email: recipient.email,
					name: recipient.name,
					role: recipient.role,
					locale: recipient.locale,
					routingOrder: recipient.routingOrder
				}))
			})
		).toBe(TAMPERED_NAME_FINGERPRINT);
	});

	it('rejects replay when a stored recipient is no longer pending', async () => {
		await expect(
			validStoredReadyReceipt(
				{
					envelopeId: ENVELOPE_ID,
					expectedGeneration: 2,
					commitSha: COMMIT_SHA,
					requestHash: GOLDEN_REQUEST_FINGERPRINT,
					auditPayloadJson: GOLDEN_AUDIT_JSON
				},
				[{ ...storedRecipients[0], status: 'viewed' }, storedRecipients[1]]
			)
		).resolves.toBe(false);
	});
});
