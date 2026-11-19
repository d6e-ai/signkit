import { gzipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RemotePdfSealProvider } from '$lib/adapters/pdf/remote-pdf-seal-provider';
import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import {
	buildVerifiedAuditChain,
	type AuditChainStep
} from '$lib/application/completion-artifacts/audit-chain-test-support';
import {
	buildCompletionManifest,
	canonicalManifestJson,
	sha256Hex,
	sha256TextHex,
	type BuildCompletionManifestInput
} from '$lib/application/completion-artifacts/completion-manifest';
import { buildCompletionPdfManifest } from '$lib/application/completion-artifacts/completion-pdf';
import {
	signPdfSealAuthorization,
	verifyPdfSealAuthorization,
	type PdfSealAuthorizationRequest
} from '$lib/application/pdf-seals/pdf-seal-authorization';
import type { TrustedPdfSealCompletion } from '$lib/application/pdf-seals/pdf-seal-authorization-issuer';
import type { ProviderSigningLedger } from '$lib/application/pdf-seals/provider-signing-gate';
import { createTrustedPdfSealCompletionReader } from '$lib/application/pdf-seals/trusted-pdf-seal-completion';
import { COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE, hashAuditEventV3 } from '$lib/domain/audit';
import { signingInstructionPrompt } from '$lib/domain/signing-instruction';
import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectStore } from '$lib/ports/object-store';
import { base64UrlEncode } from '$lib/security/opaque-token';
import {
	createAuthorizedPdfSealSubmitHandler,
	createPdfSealAuthorizationHandler
} from './authorized-pdf-seal-provider';

const envelopeId = '01900000-0000-7000-8000-000000000501';
const operationId = '01900000-0000-7000-8000-000000000502';
const otherOperationId = '01900000-0000-7000-8000-000000000503';
const signer = 'signer-1';
const at = '2026-09-01T01:00:00.000Z';
const now = new Date('2026-09-01T02:00:00.000Z');
const pdf = new TextEncoder().encode('%PDF-1.7\ntrusted executed bytes\n%%EOF');
const policy = {
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'a'.repeat(64),
	sealPolicyId: 'seal-policy',
	validationPolicyId: 'validator-policy',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null
} as const;
const identity = { issuer: 'independent-issuer', audience: 'provider' };
let keys: CryptoKeyPair;
let publicKey: string;
let reference: PdfSealAuthorizationRequest;

beforeAll(async () => {
	keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
		'sign',
		'verify'
	]);
	publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
	reference = {
		envelopeId,
		operationId,
		sourceSha256: await sha256Hex(pdf),
		sourceByteSize: pdf.length,
		...policy
	};
});

async function trustedCompletion(marked = true): Promise<TrustedPdfSealCompletion> {
	const commitSha = 'b'.repeat(40);
	const documentSetHash = 'c'.repeat(64);
	const documentSha256 = 'd'.repeat(64);
	const valueJson = JSON.stringify('Synthetic Signer');
	const valueSha256 = await sha256TextHex(valueJson);
	const steps: AuditChainStep[] = [
		{
			id: 'ready',
			eventType: 'envelope.ready',
			actorType: 'user',
			actorId: 'owner',
			occurredAt: at,
			payload: {
				commitSha,
				generation: 1,
				recipients: [{ id: signer, role: 'signer', routingOrder: 1 }]
			}
		},
		{
			id: 'sent',
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'owner',
			occurredAt: at,
			payload: {
				commitSha,
				readyAuditEventId: 'ready',
				documentSetHash,
				documentCount: 1,
				documents: [{ id: 'doc-1', sha256: documentSha256, byteSize: 123, pageCount: 1 }],
				...(marked ? { signingInstructionVersion: 1 } : {})
			}
		}
	];
	const sentEventHash = (await buildVerifiedAuditChain({ envelopeId }, steps))[1].eventHash;
	const prompt = signingInstructionPrompt(sentEventHash, 'en');
	steps.push(
		{
			id: 'signed',
			eventType: 'recipient.signed',
			actorType: 'recipient',
			actorId: signer,
			occurredAt: at,
			payload: {
				recipientId: signer,
				role: 'signer',
				routingOrder: 1,
				sentCommitSha: commitSha,
				fields: [{ id: 'field-1', fieldType: 'signature', valueSha256 }],
				signedAt: at,
				...(marked
					? {
							signingInstruction: {
								version: 1,
								locale: 'en',
								sentEventHash,
								textSha256: await sha256TextHex(prompt.statement),
								fieldGeneration: 1
							}
						}
					: {})
			}
		},
		{
			id: 'complete',
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: signer,
			occurredAt: at,
			payload: { sentCommitSha: commitSha, completedAt: at }
		}
	);
	const completion: BuildCompletionManifestInput = {
		envelopeId,
		title: 'Synthetic agreement',
		sentCommitSha: commitSha,
		draftArchiveSha256: 'e'.repeat(64),
		fieldGeneration: 1,
		documentSetHash,
		documents: [{ id: 'doc-1', sha256: documentSha256 }],
		recipients: [
			{
				id: signer,
				role: 'signer',
				routingOrder: 1,
				status: 'completed',
				decisionEventId: 'signed',
				decisionOccurredAt: at
			}
		],
		fields: [{ id: 'field-1', fieldType: 'signature', valueJson, valueSha256 }],
		auditEvents: await buildVerifiedAuditChain({ envelopeId }, steps)
	};
	const manifest = await buildCompletionManifest(completion);
	const publishedManifestSha256 = await sha256TextHex(canonicalManifestJson(manifest));
	return {
		completion,
		publishedManifestSha256,
		executedPdfByteSize: pdf.length,
		executedPdfManifest: await buildCompletionPdfManifest({
			manifest,
			manifestSha256: publishedManifestSha256,
			pdfBytes: pdf,
			artifactKind: 'executed-agreement-v1',
			pageCount: 1,
			fieldGeometry: [
				{
					id: 'field-1',
					recipientId: signer,
					fieldType: 'signature',
					required: true,
					documentId: 'doc-1',
					documentPath: null,
					position: 0,
					geometry: { page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 }
				}
			]
		})
	};
}

function issuer(snapshot: TrustedPdfSealCompletion | null) {
	const sign = vi.fn(
		async (data: Uint8Array<ArrayBuffer>) =>
			new Uint8Array(
				await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data)
			)
	);
	return {
		identity,
		policy,
		authenticate,
		readTrustedCompletion: vi.fn(async () => snapshot),
		sign,
		now: () => now
	};
}

async function configuredCompletionReader(snapshot: TrustedPdfSealCompletion) {
	const completion = snapshot.completion;
	const json = gzipSync(
		new TextEncoder().encode(canonicalManifestJson(await buildCompletionManifest(completion)))
	);
	const pdfManifest = gzipSync(
		new TextEncoder().encode(JSON.stringify(snapshot.executedPdfManifest))
	);
	const jsonSha256 = await sha256Hex(json);
	const pdfManifestSha256 = await sha256Hex(pdfManifest);
	const jsonKey = completionArtifactObjectKey(envelopeId, 'json', jsonSha256);
	const pdfManifestObjectKey = completionArtifactObjectKey(
		envelopeId,
		'pdf-manifest',
		pdfManifestSha256
	);
	const anchor = completion.auditEvents[completion.auditEvents.length - 1];
	const auditEventId = 'published';
	const publication = {
		sequence: anchor.sequence + 1,
		eventType: COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE,
		actorType: 'system',
		actorId: 'completion-artifact-worker',
		occurredAt: at,
		payload: { manifestSha256: snapshot.publishedManifestSha256, jsonSha256 },
		previousHash: anchor.eventHash
	} as const;
	const objects = new Map([
		[jsonKey, json],
		[pdfManifestObjectKey, pdfManifest]
	]);
	const get = vi.fn(async (key: string) => {
		const bytes = objects.get(key);
		return bytes === undefined ? null : new Response(new Uint8Array(bytes)).body;
	});
	const published = {
		envelopeId,
		auditEventId,
		manifestSha256: snapshot.publishedManifestSha256,
		jsonSha256,
		markdownSha256: '0'.repeat(64),
		publishedAt: at
	};
	const publicationEvent = {
		...publication,
		id: auditEventId,
		hashVersion: 3 as const,
		payloadJson: JSON.stringify(publication.payload),
		eventHash: await hashAuditEventV3(publication, { envelopeId })
	};
	const readCompletionEvidence = vi.fn(async () => ({
		auditEvents: [...completion.auditEvents, publicationEvent],
		recipients: completion.recipients,
		fields: completion.fields
	}));
	const artifacts = {
		findCompletionArtifactStatus: async () => ({ envelopeId, envelopeCompleted: true, published }),
		readCompletionEvidence
	} as unknown as CompletionArtifactStore;
	const pdfs: CompletionArtifactPdfStore = {
		publishCompletionArtifactPdf: async () => {
			throw new Error('unused');
		},
		readCompletionArtifactPdf: async () => ({
			envelopeId,
			pdfObjectKey: completionArtifactObjectKey(envelopeId, 'pdf', reference.sourceSha256),
			pdfSha256: reference.sourceSha256,
			pdfByteSize: reference.sourceByteSize,
			pdfManifestObjectKey,
			pdfManifestSha256,
			publishedAt: at
		})
	};
	const unused = async (): Promise<never> => {
		throw new Error('unused');
	};
	const storage: ObjectStore = {
		get,
		head: unused,
		putImmutable: unused,
		delete: unused,
		list: unused,
		deleteMany: unused
	};
	return {
		readTrustedCompletion: createTrustedPdfSealCompletionReader(
			artifacts,
			pdfs,
			storage,
			async (requestedEnvelope, audience) =>
				requestedEnvelope === envelopeId && audience === identity.audience
		),
		readCompletionEvidence
	};
}

async function authenticate(request: Request): Promise<string | null> {
	switch (request.headers.get('authorization')) {
		case 'Bearer scheduling-token':
			return identity.audience;
		case 'Bearer other-tenant':
			return 'other-audience';
		default:
			return null;
	}
}

function signerIngress() {
	let reserved: Parameters<ProviderSigningLedger['reserve']>[0] | undefined;
	const ledger: ProviderSigningLedger = {
		reserve: async (command) => {
			if (reserved === undefined) {
				reserved = command;
				return 'reserved';
			}
			return reserved.operationId === command.operationId &&
				reserved.authorizationSha256 === command.authorizationSha256
				? 'existing'
				: 'conflict';
		}
	};
	const receipt = { ...reference, status: 'pending', providerReceiptId: 'receipt-1' } as const;
	const sign = vi.fn(async () => receipt);
	return {
		policy,
		trust: { ...identity, publicKey },
		ledger,
		authenticate,
		sign,
		now: () => now,
		readAcceptedOperation: vi.fn(async () => receipt)
	};
}

function authorizationRequest(body: object = reference, credential = 'scheduling-token'): Request {
	return new Request(`https://provider.example/pdf-seal-authorizations/${operationId}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'idempotency-key': operationId,
			authorization: `Bearer ${credential}`
		},
		body: JSON.stringify(body)
	});
}

function submission(token: string | undefined, ref = reference, bytes = pdf): Request {
	const headers = new Headers({
		'content-type': 'application/pdf',
		authorization: 'Bearer scheduling-token',
		'idempotency-key': ref.operationId,
		'x-signkit-operation-id': ref.operationId,
		'x-signkit-envelope-id': ref.envelopeId,
		'x-signkit-source-sha256': ref.sourceSha256,
		'x-signkit-source-byte-size': String(ref.sourceByteSize),
		'x-signkit-requested-profile': ref.requestedProfile,
		'x-signkit-signer-certificate-sha256': ref.signerCertificateSha256,
		'x-signkit-seal-policy-id': ref.sealPolicyId,
		'x-signkit-validation-policy-id': ref.validationPolicyId
	});
	if (token !== undefined) headers.set('x-signkit-seal-authorization', token);
	return new Request(`https://provider.example/authorized-pdf-seals/${ref.operationId}`, {
		method: 'PUT',
		headers,
		body: bytes
	});
}

async function issuedToken(options: ReturnType<typeof issuer>, ref = reference): Promise<string> {
	const request = authorizationRequest(ref);
	request.headers.set('idempotency-key', ref.operationId);
	const response = await createPdfSealAuthorizationHandler(options)(request, ref.operationId);
	expect(response.status).toBe(200);
	const body: { authorization: string } = (await response.json()) as { authorization: string };
	return body.authorization;
}

describe('separately administered PDF seal authorization', () => {
	it('runs the authenticated remote transport through the issuer and key gate, then reads an exact replay', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(now);
		try {
			const snapshot = await trustedCompletion();
			const reader = await configuredCompletionReader(snapshot);
			const authority = { ...issuer(null), readTrustedCompletion: reader.readTrustedCompletion };
			const gate = signerIngress();
			const authorize = createPdfSealAuthorizationHandler(authority);
			const submit = createAuthorizedPdfSealSubmitHandler(gate);
			const adapter = new RemotePdfSealProvider({
				baseUrl: 'https://provider.example',
				bearerToken: 'scheduling-token',
				maxResultBytes: 1024,
				authorizationTrust: gate.trust,
				fetch: async (url, init) => {
					const request = new Request(url, init);
					return request.method === 'POST'
						? authorize(request, operationId)
						: submit(request, operationId);
				}
			});
			const command = () => ({ ...reference, source: new Response(pdf).body! });
			expect(await adapter.submit(command())).toMatchObject({ providerReceiptId: 'receipt-1' });
			expect(await adapter.submit(command())).toMatchObject({ providerReceiptId: 'receipt-1' });
			expect(gate.sign).toHaveBeenCalledOnce();
			expect(reader.readCompletionEvidence).toHaveBeenCalledWith(envelopeId, {
				throughSequence: 5
			});
			expect(gate.readAcceptedOperation).toHaveBeenCalledOnce();
			expect(gate.sign).toHaveBeenCalledWith(
				expect.objectContaining({
					envelopeId,
					operationId,
					evidenceSha256: snapshot.publishedManifestSha256
				}),
				pdf
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never treats instance credentials or caller-supplied evidence as a grant', async () => {
		const noEvidence = issuer(null);
		const authorize = createPdfSealAuthorizationHandler(noEvidence);
		const legitimate = await trustedCompletion();
		expect(
			(
				await authorize(
					authorizationRequest({ ...reference, completion: legitimate.completion }),
					operationId
				)
			).status
		).toBe(403);
		expect(noEvidence.readTrustedCompletion).toHaveBeenCalledWith(envelopeId, identity.audience);
		expect(noEvidence.sign).not.toHaveBeenCalled();
		const gate = signerIngress();
		expect(
			(await createAuthorizedPdfSealSubmitHandler(gate)(submission(undefined), operationId)).status
		).toBe(403);
		expect(gate.sign).not.toHaveBeenCalled();
	});

	it('requires the authenticated scheduling audience to match before reading trusted evidence', async () => {
		const authority = issuer(await trustedCompletion());
		const authorize = createPdfSealAuthorizationHandler(authority);
		expect(
			(await authorize(authorizationRequest(reference, 'other-tenant'), operationId)).status
		).toBe(401);
		expect(authority.readTrustedCompletion).not.toHaveBeenCalled();
		const token = await issuedToken(authority);
		const gate = signerIngress();
		const request = submission(token);
		request.headers.set('authorization', 'Bearer other-tenant');
		expect((await createAuthorizedPdfSealSubmitHandler(gate)(request, operationId)).status).toBe(
			401
		);
		expect(gate.sign).not.toHaveBeenCalled();
	});

	it('reconciles an uncertain key-service result without a second key attempt', async () => {
		const gate = signerIngress();
		gate.sign.mockRejectedValueOnce(new Error('result unavailable'));
		const handle = createAuthorizedPdfSealSubmitHandler(gate);
		const token = await issuedToken(issuer(await trustedCompletion()));
		expect((await handle(submission(token), operationId)).status).toBe(503);
		expect((await handle(submission(token), operationId)).status).toBe(200);
		expect(gate.sign).toHaveBeenCalledOnce();
		expect(gate.readAcceptedOperation).toHaveBeenCalledOnce();
	});

	it('rejects historical or mismatched publications and independently checks actual field values', async () => {
		const legacy = issuer(await trustedCompletion(false));
		expect(
			(await createPdfSealAuthorizationHandler(legacy)(authorizationRequest(), operationId)).status
		).toBe(403);
		const trusted = await trustedCompletion();
		const modified = {
			...trusted,
			completion: {
				...trusted.completion,
				fields: [{ ...trusted.completion.fields[0], valueJson: '"changed"' }]
			}
		};
		const authority = issuer(modified);
		const authorize = createPdfSealAuthorizationHandler(authority);
		expect((await authorize(authorizationRequest(), operationId)).status).toBe(403);
		expect(
			(
				await authorize(
					authorizationRequest({ ...reference, sourceSha256: 'f'.repeat(64) }),
					operationId
				)
			).status
		).toBe(403);
		expect(authority.sign).not.toHaveBeenCalled();
	});

	it('blocks modified source bytes, permission expiry, an untrusted issuer and a different operation', async () => {
		const authority = issuer(await trustedCompletion());
		const token = await issuedToken(authority);
		const gate = signerIngress();
		const handler = createAuthorizedPdfSealSubmitHandler(gate);
		const altered = pdf.slice();
		altered[11] ^= 1;
		expect((await handler(submission(token, reference, altered), operationId)).status).toBe(403);
		const other = { ...reference, operationId: otherOperationId };
		expect((await handler(submission(token, other), otherOperationId)).status).toBe(403);
		const wrongIssuer = await signPdfSealAuthorization(
			reference,
			{ evidenceSha256: '2'.repeat(64), sentEventHash: '3'.repeat(64) },
			{ ...identity, issuer: 'instance-administrator' },
			authority.sign,
			now
		);
		expect((await handler(submission(wrongIssuer), operationId)).status).toBe(403);
		const expired = createAuthorizedPdfSealSubmitHandler({
			...gate,
			now: () => new Date(now.getTime() + 300_000)
		});
		expect((await expired(submission(token), operationId)).status).toBe(403);
		expect(gate.sign).not.toHaveBeenCalled();
		expect((await handler(submission(token), operationId)).status).toBe(200);
		expect(
			(await handler(submission(await issuedToken(authority, other), other), otherOperationId))
				.status
		).toBe(409);
		expect(gate.sign).toHaveBeenCalledOnce();
	});

	it('does not verify a grant signed by an instance-controlled key', async () => {
		const unrelated = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign', 'verify']
		);
		const token = await signPdfSealAuthorization(
			reference,
			{ evidenceSha256: '2'.repeat(64), sentEventHash: '3'.repeat(64) },
			identity,
			async (data) =>
				new Uint8Array(
					await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, unrelated.privateKey, data)
				),
			now
		);
		expect(
			await verifyPdfSealAuthorization(token, reference, { ...identity, publicKey }, now)
		).toBeNull();
	});
});
