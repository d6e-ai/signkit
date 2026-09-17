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
	findEnvelope(envelopeId: string): Promise<Envelope | null>;
	compareAndSetDraftPointer(envelopeId: string, update: DraftPointerUpdate): Promise<boolean>;
	transition(
		envelopeId: string,
		expected: EnvelopeStatus,
		next: EnvelopeStatus,
		at: string
	): Promise<boolean>;
}
