import type { Envelope, EnvelopeStatus } from '$lib/domain/envelope';

export interface DraftPointerUpdate {
	expectedGeneration: number;
	nextGeneration: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	updatedAt: string;
}

export interface EnvelopeStore {
	findForOrganization(organizationId: string, envelopeId: string): Promise<Envelope | null>;
	compareAndSetDraftPointer(
		organizationId: string,
		envelopeId: string,
		update: DraftPointerUpdate
	): Promise<boolean>;
	transition(
		organizationId: string,
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean>;
}
