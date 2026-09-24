import type { MarkdownPath } from '$lib/domain/envelope';
import type { DraftTrackedPath } from '$lib/domain/document-set';

export interface DraftActor {
	id: string;
	name: string;
	email: string;
	type: 'user' | 'agent' | 'system';
}

export interface DraftEdit {
	path: DraftTrackedPath;
	content: string;
}

export interface DraftDocument {
	path: MarkdownPath;
	content: string;
}

export interface DraftCommitOptions {
	replaceTrackedPaths?: boolean;
}

export interface DraftVersion {
	commitSha: string;
	archive: Uint8Array;
	archiveSha256: string;
	paths: readonly string[];
}

export interface VerifiedCommitDetails {
	commitSha: string;
	message: string;
}

export interface VerifiedDraftRevisionSnapshot {
	commitSha: string;
	message: string;
	documents: readonly DraftDocument[];
	manifest: string | null;
}

export interface DraftRepository {
	read(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]>;
	readManifest(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<string | null>;
	readCommitMessage?(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<string | null>;
	readRevisionSnapshot?(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<VerifiedDraftRevisionSnapshot | null>;
	commit(
		archive: Uint8Array | null,
		edits: readonly DraftEdit[],
		message: string,
		actor: DraftActor,
		options?: DraftCommitOptions
	): Promise<DraftVersion>;
}
