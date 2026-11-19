import { verifyAuditEventRecord } from '$lib/application/completion-artifacts/audit-event-integrity';
import { CompletionEvidenceService } from '$lib/application/completion-artifacts/completion-evidence-service';
import {
	COMPLETION_MANIFEST_SCHEMA,
	type CompletionManifestV1
} from '$lib/application/completion-artifacts/completion-manifest';
import type { CompletionPdfManifestV2 } from '$lib/application/completion-artifacts/completion-pdf';
import { COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE, sha256TextHex } from '$lib/domain/audit';
import {
	MAX_COMPLETION_AUDIT_VERIFY_EVENTS,
	type CompletionArtifactStore
} from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectStore } from '$lib/ports/object-store';
import type { TrustedPdfSealCompletion } from './pdf-seal-authorization-issuer';

/** Bind these stores to the independently administered recipient and artifact plane. */
export function createTrustedPdfSealCompletionReader(
	artifacts: CompletionArtifactStore,
	pdfs: CompletionArtifactPdfStore,
	objects: ObjectStore,
	canReadEnvelope: (envelopeId: string, audience: string) => Promise<boolean>
): (envelopeId: string, audience: string) => Promise<TrustedPdfSealCompletion | null> {
	const evidenceReader = new CompletionEvidenceService(artifacts, objects, pdfs);
	return async (envelopeId, audience) => {
		if (!(await canReadEnvelope(envelopeId, audience))) return null;
		const status = await artifacts.findCompletionArtifactStatus(envelopeId);
		const published = status?.published;
		if (status?.envelopeCompleted !== true || published?.envelopeId !== envelopeId) return null;
		const pdf = await pdfs.readCompletionArtifactPdf(envelopeId);
		if (pdf?.envelopeId !== envelopeId || pdf.pdfByteSize === null) return null;
		const evidence = await evidenceReader.readEvidence(envelopeId);
		const pdfManifest = await evidenceReader.readPdfManifest(envelopeId);
		if (
			evidence === null ||
			evidence.digest !== published.jsonSha256 ||
			pdfManifest?.digest !== pdf.pdfManifestSha256 ||
			(await sha256TextHex(evidence.content)) !== published.manifestSha256
		)
			return null;
		const manifest: CompletionManifestV1 = JSON.parse(evidence.content);
		const executedPdfManifest: CompletionPdfManifestV2 = JSON.parse(pdfManifest.content);
		const head = manifest.auditProof?.headSequence;
		if (
			manifest.schema !== COMPLETION_MANIFEST_SCHEMA ||
			manifest.envelopeId !== envelopeId ||
			!Number.isSafeInteger(head) ||
			head < 1 ||
			head > MAX_COMPLETION_AUDIT_VERIFY_EVENTS ||
			!Array.isArray(manifest.documents) ||
			executedPdfManifest.pdfSha256 !== pdf.pdfSha256
		)
			return null;
		const { auditEvents, recipients, fields } = await artifacts.readCompletionEvidence(envelopeId, {
			throughSequence: head + 1
		});
		const completed = auditEvents[head - 1];
		const publication = auditEvents[head];
		if (
			publication?.id !== published.auditEventId ||
			publication.eventType !== COMPLETION_ARTIFACT_PUBLISHED_EVENT_TYPE ||
			completed?.id !== manifest.auditProof.anchorEventId ||
			publication.previousHash !== completed.eventHash ||
			publication.sequence !== head + 1
		)
			return null;
		const payload = await verifyAuditEventRecord(publication, { envelopeId });
		if (
			typeof payload !== 'object' ||
			payload === null ||
			!('manifestSha256' in payload) ||
			payload.manifestSha256 !== published.manifestSha256 ||
			!('jsonSha256' in payload) ||
			payload.jsonSha256 !== published.jsonSha256
		)
			return null;
		return {
			completion: {
				envelopeId,
				title: manifest.title,
				sentCommitSha: manifest.sentCommitSha,
				draftArchiveSha256: manifest.draftArchiveSha256,
				fieldGeneration: manifest.fieldGeneration,
				documentSetHash: manifest.documentSetHash,
				documents: manifest.documents,
				recipients,
				fields,
				auditEvents: auditEvents.slice(0, head)
			},
			publishedManifestSha256: published.manifestSha256,
			executedPdfManifest,
			executedPdfByteSize: pdf.pdfByteSize
		};
	};
}
