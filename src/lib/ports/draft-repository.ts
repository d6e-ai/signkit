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

export interface DraftVersion {
	commitSha: string;
	archive: Uint8Array;
	archiveSha256: string;
}

export interface DraftRepository {
	commit(
		archive: Uint8Array | null,
		edits: readonly DraftEdit[],
		message: string,
		actor: DraftActor
	): Promise<DraftVersion>;
}
