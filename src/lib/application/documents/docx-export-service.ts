import {
	readImmutableDraftRevision,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectStore } from '$lib/ports/object-store';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';

export type EnvelopeDocxExportResult =
	| { outcome: 'exported'; bytes: Uint8Array; commitSha: string }
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
): Promise<Uint8Array> {
	const documents: readonly DraftDocument[] = await readImmutableDraftRevision(
		revision,
		objects,
		repository
	);
	return exportMarkdownToDocx({
		commitSha: revision.commitSha,
		documents: documents.map((document: DraftDocument) => ({
			path: document.path,
			content: document.content
		}))
	});
}

/**
 * Resolves the envelope's current trusted Git locator and exports that pinned
 * revision. Sent envelopes use `sentCommitSha` when present; otherwise the
 * current repository head. DOCX bytes are derived, never stored in Git.
 */
export async function exportEnvelopeDocx(
	organizationId: string,
	envelopeId: string,
	envelopes: Pick<EnvelopeStore, 'findForOrganization'>,
	objects: ObjectStore,
	repository: DraftRepository
): Promise<EnvelopeDocxExportResult> {
	const envelope = await envelopes.findForOrganization(organizationId, envelopeId);
	if (envelope === null) return { outcome: 'not_found' };
	const commitSha: string | null = envelope.sentCommitSha ?? envelope.repositoryHead;
	if (
		commitSha === null ||
		envelope.repositoryArchiveKey === null ||
		envelope.repositoryArchiveSha256 === null
	) {
		return { outcome: 'empty_draft' };
	}
	const bytes: Uint8Array = await exportPinnedDocx(
		{
			organizationId,
			envelopeId,
			commitSha,
			archiveKey: envelope.repositoryArchiveKey,
			archiveSha256: envelope.repositoryArchiveSha256
		},
		objects,
		repository
	);
	return { outcome: 'exported', bytes, commitSha };
}
