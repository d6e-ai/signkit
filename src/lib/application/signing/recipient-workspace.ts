import type { FieldGeometry, FieldType } from '$lib/domain/envelope';
import type {
	EnvelopeSentDocumentStore,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import type {
	EnvelopeSentPdfStore,
	SentPdfDocumentPages,
	SentPdfPointer
} from '$lib/ports/envelope-sent-pdf-store';
import type {
	RecipientFieldDeclaration,
	RecipientOwnFields
} from '$lib/ports/recipient-field-declaration-store';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import {
	toPublicRecipientAccess,
	type PublicRecipientAccessContext,
	type RecipientAccessApplicationPort
} from './recipient-access';

/** A field the recipient must complete, positioned on one sent document. */
export interface RecipientPlacedField {
	id: string;
	documentId: string | null;
	fieldType: FieldType;
	label: string;
	required: boolean;
	geometry: FieldGeometry;
}

export interface RecipientSentDocument {
	documentId: string;
	position: number;
	title: string;
	kind: 'markdown' | 'pdf' | 'legacy';
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
}

export interface RecipientWorkspace {
	access: PublicRecipientAccessContext;
	documents: readonly RecipientSentDocument[];
	source: 'document-set' | 'legacy';
	fields: readonly RecipientPlacedField[];
	fieldGeneration: number;
}

export interface RecipientWorkspaceApplicationPort {
	resolve(token: string, at: string): Promise<RecipientWorkspace | null>;
}

export type RecipientFieldReader = (context: {
	envelopeId: string;
	recipientId: string;
}) => Promise<RecipientOwnFields | null>;

export class RecipientWorkspaceIntegrityError extends Error {
	readonly code = 'RECIPIENT_WORKSPACE_INTEGRITY_ERROR';

	constructor() {
		super('The pinned recipient workspace failed its integrity check');
		this.name = 'RecipientWorkspaceIntegrityError';
	}
}

/**
 * Resolves everything the signing page needs, and nothing more.
 *
 * Newly sent envelopes expose one entry per document in the pinned set. Envelopes
 * already sent against `envelope_sent_pdf` stay a frozen one-document bundle
 * whose page ranges come from the stored firstPage..lastPage map. The bytes
 * themselves are served separately over a same-origin session endpoint.
 */
export class RecipientWorkspaceService implements RecipientWorkspaceApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly sentDocuments: EnvelopeSentDocumentStore,
		private readonly sentPdf: EnvelopeSentPdfStore,
		private readonly readFields: RecipientFieldReader,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async resolve(token: string, at: string): Promise<RecipientWorkspace | null> {
		const before: RecipientSigningContext | null = await this.access.resolve(token, at);
		if (before === null) return null;

		const set: SentDocumentSetPointer | null = await this.sentDocuments.findSet(
			before.envelopeId,
			before.sentRevision.commitSha
		);
		const pointer: SentPdfPointer | null =
			set === null
				? await this.sentPdf.findSentPdf(before.envelopeId, before.sentRevision.commitSha)
				: null;
		if (set === null && pointer === null) throw new RecipientWorkspaceIntegrityError();

		const ownFields: RecipientOwnFields | null = await this.readFields({
			envelopeId: before.envelopeId,
			recipientId: before.recipientId
		});
		if (ownFields === null) throw new RecipientWorkspaceIntegrityError();
		const fields: readonly RecipientPlacedField[] =
			set !== null
				? toPlacedFieldsForSet(ownFields.fields, set)
				: toPlacedFieldsForLegacy(ownFields.fields, pointer!);

		const after: RecipientSigningContext | null = await this.access.resolve(
			token,
			this.now().toISOString()
		);
		if (after === null) return null;
		if (!sameAuthorizationBoundary(before, after)) {
			throw new RecipientWorkspaceIntegrityError();
		}

		return {
			access: toPublicRecipientAccess(after),
			documents:
				set !== null
					? set.documents.map((document): RecipientSentDocument => ({
							documentId: document.documentId,
							position: document.position,
							title: document.title,
							kind: document.kind,
							pageCount: document.pageCount,
							pageWidth: document.pageWidth,
							pageHeight: document.pageHeight
						}))
					: [
							{
								documentId: LEGACY_SENT_DOCUMENT_ID,
								position: 0,
								title: pointer!.documents[0]?.title ?? 'Agreement',
								kind: 'legacy',
								pageCount: pointer!.pageCount,
								pageWidth: pointer!.pageWidth,
								pageHeight: pointer!.pageHeight
							}
						],
			source: set !== null ? 'document-set' : 'legacy',
			fields,
			fieldGeneration: ownFields.fieldGeneration
		};
	}
}

/** Not a live document ID. Marks the frozen concatenated artifact for already-sent envelopes. */
export const LEGACY_SENT_DOCUMENT_ID: string = 'legacy';

function toPlacedFieldsForSet(
	fields: readonly RecipientFieldDeclaration[],
	set: SentDocumentSetPointer
): readonly RecipientPlacedField[] {
	const pagesById: Map<string, SentDocumentSetPointer['documents'][number]> = new Map(
		set.documents.map((document) => [document.documentId, document] as const)
	);
	return fields.map((field: RecipientFieldDeclaration): RecipientPlacedField => {
		const geometry: FieldGeometry | null = field.geometry;
		const documentId: string | null = field.documentId;
		const document = documentId === null ? undefined : pagesById.get(documentId);
		if (
			geometry === null ||
			documentId === null ||
			document === undefined ||
			geometry.page < 1 ||
			geometry.page > document.pageCount ||
			!isUnitFraction(geometry.x) ||
			!isUnitFraction(geometry.y) ||
			!isPositiveFraction(geometry.width) ||
			!isPositiveFraction(geometry.height) ||
			geometry.x + geometry.width > 1.0001 ||
			geometry.y + geometry.height > 1.0001
		) {
			throw new RecipientWorkspaceIntegrityError();
		}
		return {
			id: field.id,
			documentId,
			fieldType: field.fieldType,
			label: field.label,
			required: field.required,
			geometry
		};
	});
}

function toPlacedFieldsForLegacy(
	fields: readonly RecipientFieldDeclaration[],
	pointer: SentPdfPointer
): readonly RecipientPlacedField[] {
	const pagesByPath: Map<string, SentPdfDocumentPages> = new Map(
		pointer.documents.map((section: SentPdfDocumentPages) => [section.path, section] as const)
	);
	return fields.map((field: RecipientFieldDeclaration): RecipientPlacedField => {
		const geometry: FieldGeometry | null = field.geometry;
		const section: SentPdfDocumentPages | undefined =
			field.documentPath === null ? undefined : pagesByPath.get(field.documentPath);
		if (
			geometry === null ||
			section === undefined ||
			geometry.page < section.firstPage ||
			geometry.page > section.lastPage ||
			geometry.page > pointer.pageCount ||
			!isUnitFraction(geometry.x) ||
			!isUnitFraction(geometry.y) ||
			!isPositiveFraction(geometry.width) ||
			!isPositiveFraction(geometry.height) ||
			geometry.x + geometry.width > 1.0001 ||
			geometry.y + geometry.height > 1.0001
		) {
			throw new RecipientWorkspaceIntegrityError();
		}
		return {
			id: field.id,
			documentId: LEGACY_SENT_DOCUMENT_ID,
			fieldType: field.fieldType,
			label: field.label,
			required: field.required,
			geometry
		};
	});
}

function isUnitFraction(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveFraction(value: number): boolean {
	return Number.isFinite(value) && value > 0 && value <= 1;
}

function sameAuthorizationBoundary(
	left: RecipientSigningContext,
	right: RecipientSigningContext
): boolean {
	return (
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.sentRevision.commitSha === right.sentRevision.commitSha &&
		left.sentRevision.archiveKey === right.sentRevision.archiveKey &&
		left.sentRevision.archiveSha256 === right.sentRevision.archiveSha256
	);
}
