import {
	readImmutableDraftRevision,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectStore } from '$lib/ports/object-store';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';
import { parseDocumentSet, type DocumentSetLeaf } from '$lib/domain/document-set';
import { isMarkdownPath } from '$lib/domain/envelope';

export type EnvelopeDocxExportResult =
	| { outcome: 'exported'; bytes: Uint8Array; commitSha: string; skippedPdfCount: number }
	| { outcome: 'not_found' }
	| { outcome: 'empty_draft' };

/**
 * Renders a specific, already-pinned Git commit's tracked documents into a
 * DOCX byte stream. Reads through `readImmutableDraftRevision`, the same
 * trusted-locator boundary the recipient workspace and completion artifact
 * paths use, so this can never be pointed at an untrusted or mutable commit
 * reference. The resulting bytes are a transient or retained artifact outside
 * Git; this service has no opinion on retention or delivery.
 */
export async function exportPinnedDocx(
	revision: ImmutableDraftRevision,
	objects: ObjectStore,
	repository: DraftRepository
): Promise<{ bytes: Uint8Array; skippedPdfCount: number }> {
	const verified = await readImmutableDraftRevision(revision, objects, repository);
	const markdownDocuments: readonly DraftDocument[] = verified.documents.filter((document) =>
		isMarkdownPath(document.path)
	);
	if (markdownDocuments.length === 0) {
		throw new Error('The pinned revision contains no Markdown documents to export');
	}
	const skippedPdfCount: number = await countSkippedPdfDocuments(
		verified.archive,
		repository,
		revision.commitSha
	);
	return {
		bytes: exportMarkdownToDocx({
			commitSha: revision.commitSha,
			documents: markdownDocuments.map((document: DraftDocument) => ({
				path: document.path,
				content: document.content
			}))
		}),
		skippedPdfCount
	};
}

async function countSkippedPdfDocuments(
	archive: Uint8Array,
	repository: DraftRepository,
	commitSha: string
): Promise<number> {
	const manifestJson: string | null = await repository.readManifest(archive, commitSha);
	if (manifestJson === null) return 0;
	try {
		return parseDocumentSet(manifestJson).documents.filter(
			(leaf: DocumentSetLeaf): boolean => leaf.kind === 'pdf'
		).length;
	} catch {
		return 0;
	}
}

/**
 * Resolves the envelope's current trusted Git locator and exports that pinned
 * revision. Sent envelopes use `sentCommitSha` when present; otherwise the
 * current repository head. DOCX bytes are derived, never stored in Git.
 */
export async function exportEnvelopeDocx(
	envelopeId: string,
	envelopes: Pick<EnvelopeStore, 'findEnvelope'>,
	objects: ObjectStore,
	repository: DraftRepository
): Promise<EnvelopeDocxExportResult> {
	const envelope = await envelopes.findEnvelope(envelopeId);
	if (envelope === null) return { outcome: 'not_found' };
	const commitSha: string | null = envelope.sentCommitSha ?? envelope.repositoryHead;
	if (
		commitSha === null ||
		envelope.repositoryArchiveKey === null ||
		envelope.repositoryArchiveSha256 === null
	) {
		return { outcome: 'empty_draft' };
	}
	const exported = await exportPinnedDocx(
		{
			envelopeId,
			commitSha,
			archiveKey: envelope.repositoryArchiveKey,
			archiveSha256: envelope.repositoryArchiveSha256
		},
		objects,
		repository
	);
	return {
		outcome: 'exported',
		bytes: exported.bytes,
		commitSha,
		skippedPdfCount: exported.skippedPdfCount
	};
}
