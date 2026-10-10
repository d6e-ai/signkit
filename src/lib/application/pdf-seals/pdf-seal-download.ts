import {
	ExactObjectStreamError,
	readExactObjectStream
} from '$lib/application/completion-artifacts/exact-object-stream';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import {
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	assertValidPdfSealValidationEvidence,
	MAX_SEALED_PDF_BYTES
} from '$lib/ports/pdf-seal-job-store';
import type { PdfSealPublicationStore } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealProfile } from '$lib/ports/pdf-seal-provider';
import type { PdfSealRequestStore } from '$lib/ports/pdf-seal-request-store';
import { pdfSealSealedObjectKey } from './pdf-seal-service';

const SHA256_PATTERN: RegExp = /^[0-9a-f]{64}$/;

export interface DownloadedPdfSeal {
	bytes: Uint8Array<ArrayBuffer>;
	sha256: string;
	byteSize: number;
	achievedProfile: PdfSealProfile;
}

export type PdfSealDownloadResult =
	| { outcome: 'available'; pdf: DownloadedPdfSeal }
	| { outcome: 'not_found' }
	| { outcome: 'not_published' };

export interface PdfSealDownloadApplicationPort {
	read(envelopeId: string): Promise<PdfSealDownloadResult>;
}

export class PdfSealDownloadError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'PdfSealDownloadError';
	}
}

/**
 * Reads only an atomically published, independently validated seal. The SQL
 * publication is the authority; the object is still re-opened, length-checked,
 * and re-hashed on every download so storage drift fails closed.
 */
export class PdfSealDownloadService implements PdfSealDownloadApplicationPort {
	readonly #requests: PdfSealRequestStore;
	readonly #publications: PdfSealPublicationStore;
	readonly #objects: ObjectStore;

	constructor(
		requests: PdfSealRequestStore,
		publications: PdfSealPublicationStore,
		objects: ObjectStore
	) {
		this.#requests = requests;
		this.#publications = publications;
		this.#objects = objects;
	}

	async read(envelopeId: string): Promise<PdfSealDownloadResult> {
		let publication = await this.#publications.readPdfSealPublicationByEnvelope(envelopeId);
		if (publication === null) {
			const status = await this.#requests.findStatus(envelopeId);
			if (status.status === 'not_found') return { outcome: 'not_found' };
			if (status.status !== 'published') return { outcome: 'not_published' };
			// A publish may commit between the first read and the status read. One
			// bounded re-read distinguishes that harmless race from inconsistent SQL.
			publication = await this.#publications.readPdfSealPublicationByEnvelope(envelopeId);
			if (publication === null) {
				throw new PdfSealDownloadError('pdf_seal_publication_missing');
			}
		}

		const artifact = publication.sealedArtifact;
		try {
			assertValidPdfSealFrozenReference(publication);
			assertValidPdfSealArtifact(
				artifact,
				publication.sourceByteSize,
				publication.requestedProfile
			);
			assertValidPdfSealValidationEvidence(
				publication.validationEvidence,
				publication.requestedProfile
			);
		} catch {
			throw new PdfSealDownloadError('pdf_seal_publication_invalid');
		}
		if (
			publication.envelopeId !== envelopeId ||
			!SHA256_PATTERN.test(artifact.sha256) ||
			!Number.isSafeInteger(artifact.byteSize) ||
			artifact.byteSize < 1 ||
			artifact.byteSize > MAX_SEALED_PDF_BYTES
		) {
			throw new PdfSealDownloadError('pdf_seal_publication_invalid');
		}
		const expectedKey: string = pdfSealSealedObjectKey(envelopeId, artifact.sha256);
		if (artifact.objectKey !== expectedKey) {
			throw new PdfSealDownloadError('pdf_seal_object_key_mismatch');
		}

		const metadata: ObjectMetadata | null = await this.#objects.head(expectedKey);
		if (metadata === null) throw new PdfSealDownloadError('pdf_seal_object_missing');
		if (
			metadata.key !== expectedKey ||
			metadata.contentType !== 'application/pdf' ||
			metadata.sha256 !== artifact.sha256 ||
			metadata.size !== artifact.byteSize
		) {
			throw new PdfSealDownloadError('pdf_seal_object_mismatch');
		}
		const stream: ReadableStream<Uint8Array> | null = await this.#objects.get(expectedKey);
		if (stream === null) throw new PdfSealDownloadError('pdf_seal_object_missing');

		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = await readExactObjectStream(stream, artifact.byteSize);
		} catch (error: unknown) {
			if (error instanceof ExactObjectStreamError) {
				throw new PdfSealDownloadError('pdf_seal_object_mismatch');
			}
			throw error;
		}
		if ((await sha256Hex(bytes)) !== artifact.sha256) {
			throw new PdfSealDownloadError('pdf_seal_object_mismatch');
		}
		return {
			outcome: 'available',
			pdf: {
				bytes,
				sha256: artifact.sha256,
				byteSize: artifact.byteSize,
				achievedProfile: artifact.achievedProfile
			}
		};
	}
}

export function pdfSealDownloadFailureLog(error: unknown): {
	errorName: string;
	code?: string;
} {
	const errorName: string = error instanceof Error ? error.name : 'UnknownError';
	return error instanceof PdfSealDownloadError ? { errorName, code: error.code } : { errorName };
}
