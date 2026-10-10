export interface PersistedDraftRevisionLocator {
	envelopeId: string;
	generation: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	updatedAt: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	auditPayloadJson: string;
}

export interface DraftRevisionStore {
	listDraftRevisionLocators(
		envelopeId: string,
		options?: { limit?: number; cursor?: number }
	): Promise<readonly PersistedDraftRevisionLocator[]>;
	findDraftRevisionLocatorByGeneration(
		envelopeId: string,
		generation: number
	): Promise<PersistedDraftRevisionLocator | null>;
	findDraftRevisionLocatorByCommit(
		envelopeId: string,
		commitSha: string
	): Promise<PersistedDraftRevisionLocator | null>;
}
