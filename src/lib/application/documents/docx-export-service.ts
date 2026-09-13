import {
	readImmutableDraftRevision,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectStore } from '$lib/ports/object-store';
import { exportMarkdownToDocx } from '$lib/adapters/documents/docx-export';

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
