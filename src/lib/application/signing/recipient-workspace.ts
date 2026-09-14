import type { FieldGeometry, FieldType } from '$lib/domain/envelope';
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

/**
 * One section of the sent PDF, named for the recipient's navigation.
 *
 * Deliberately no Markdown path and no storage key: the recipient is shown a
 * rendered document, and nothing about how SignKit stores or versions that
 * document is theirs to know.
 */
export interface RecipientDocumentSection {
	title: string;
	firstPage: number;
	lastPage: number;
}

/** A field the recipient must complete, positioned on the sent PDF. */
export interface RecipientPlacedField {
	id: string;
	fieldType: FieldType;
	label: string;
	required: boolean;
	geometry: FieldGeometry;
}

export interface RecipientSentDocument {
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	sections: readonly RecipientDocumentSection[];
}

export interface RecipientWorkspace {
	access: PublicRecipientAccessContext;
	document: RecipientSentDocument;
	fields: readonly RecipientPlacedField[];
	fieldGeneration: number;
}

export interface RecipientWorkspaceApplicationPort {
	resolve(token: string, at: string): Promise<RecipientWorkspace | null>;
}

export type RecipientFieldReader = (context: {
	organizationId: string;
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
 * The workspace is pinned to the exact commit the envelope was sent at, and
 * the only document surface it exposes is the geometry of the PDF rendering
 * of that commit -- page count, page size, and section boundaries. The bytes
 * themselves are served separately, over a same-origin session endpoint, so
 * no document content and no object key ever reaches the page payload.
 */
export class RecipientWorkspaceService implements RecipientWorkspaceApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly sentPdf: EnvelopeSentPdfStore,
		private readonly readFields: RecipientFieldReader,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async resolve(token: string, at: string): Promise<RecipientWorkspace | null> {
		const before: RecipientSigningContext | null = await this.access.resolve(token, at);
		if (before === null) return null;

		const pointer: SentPdfPointer | null = await this.sentPdf.findSentPdf(
			before.organizationId,
			before.envelopeId,
			before.sentRevision.commitSha
		);
		if (pointer === null) throw new RecipientWorkspaceIntegrityError();
		const ownFields: RecipientOwnFields | null = await this.readFields({
			organizationId: before.organizationId,
			envelopeId: before.envelopeId,
			recipientId: before.recipientId
		});
		if (ownFields === null) throw new RecipientWorkspaceIntegrityError();
		const fields: readonly RecipientPlacedField[] = toPlacedFields(ownFields.fields, pointer);

		// A capability can be revoked, or the envelope re-pinned, while the
		// database is being read. Re-resolve immediately before disclosure and
		// require the same pinned source.
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
			document: {
				pageCount: pointer.pageCount,
				pageWidth: pointer.pageWidth,
				pageHeight: pointer.pageHeight,
				sections: pointer.documents.map(
					(section: SentPdfDocumentPages): RecipientDocumentSection => ({
						title: section.title,
						firstPage: section.firstPage,
						lastPage: section.lastPage
					})
				)
			},
			fields,
			fieldGeneration: ownFields.fieldGeneration
		};
	}
}

/**
 * Every field a signer is asked to complete has to be reachable on the page
 * they are shown. A field with no geometry, or geometry pointing outside its
 * own document's pages, would be invisible -- so it fails the whole workspace
 * closed instead of quietly disappearing from a legal obligation.
 */
function toPlacedFields(
	fields: readonly RecipientFieldDeclaration[],
	pointer: SentPdfPointer
): readonly RecipientPlacedField[] {
	const pagesByPath: Map<string, SentPdfDocumentPages> = new Map(
		pointer.documents.map((section: SentPdfDocumentPages) => [section.path, section] as const)
	);
	return fields.map((field: RecipientFieldDeclaration): RecipientPlacedField => {
		const geometry: FieldGeometry | null = field.geometry;
		const section: SentPdfDocumentPages | undefined = pagesByPath.get(field.documentPath);
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
		left.organizationId === right.organizationId &&
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.sentRevision.commitSha === right.sentRevision.commitSha &&
		left.sentRevision.archiveKey === right.sentRevision.archiveKey &&
		left.sentRevision.archiveSha256 === right.sentRevision.archiveSha256
	);
}
