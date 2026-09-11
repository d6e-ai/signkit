export interface DraftActor {
	id: string;
	name: string;
	email: string;
	type: 'user' | 'agent' | 'system';
}

export interface DraftEdit {
	path: `documents/${string}.md`;
	content: string;
}

export interface DraftDocument {
	path: `documents/${string}.md`;
	content: string;
}

export interface DraftVersion {
	commitSha: string;
	archive: Uint8Array;
	archiveSha256: string;
}

export interface DraftRepository {
	read(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]>;
	commit(
		archive: Uint8Array | null,
		edits: readonly DraftEdit[],
		message: string,
		actor: DraftActor
	): Promise<DraftVersion>;
}
