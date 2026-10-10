import {
	composePdf,
	displayedSize,
	MAX_COMPOSED_PDF_IMAGE_WORKING_SET_BYTES,
	MAX_COMPOSED_PDF_IMAGES,
	MAX_COMPOSED_PDF_INPUT_BYTES,
	MAX_COMPOSED_PDF_OVERLAY_OPERATIONS,
	MAX_COMPOSED_PDF_PAGES,
	MAX_COMPOSED_PDF_TEXT_LENGTH,
	overlayOutputReserve,
	overlayReservedObjectCount,
	PdfCompositionError,
	type ComposePdfResult,
	type OverlayBudgetPage,
	type OverlayOperationBound,
	type PdfCompositionReason
} from '$lib/adapters/pdf/pdf-composer';
import {
	PdfObjectReader,
	PdfPageMetadataError,
	type PdfPageNode
} from '$lib/adapters/pdf/pdf-object-reader';
import {
	buildCompletionPdfPages,
	CompletionPdfBoundExceededError,
	renderCompletionPdf
} from '$lib/application/completion-artifacts/completion-pdf';
import { MAX_EVIDENCE_SUMMARY_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import {
	COMPLETION_MANIFEST_SCHEMA,
	MAX_MANIFEST_FIELD_COUNT,
	type CompletionManifestDocument,
	type CompletionManifestField,
	type CompletionManifestRecipient,
	type CompletionManifestV1
} from '$lib/application/completion-artifacts/completion-manifest';
import {
	MAX_EXECUTED_PDF_BYTES,
	MAX_EXECUTED_PDF_DOCUMENTS,
	MAX_EXECUTED_PDF_PAGES
} from '$lib/application/completion-artifacts/executed-pdf';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	MAX_SIGNATURE_EMITTED_IMAGE_BYTES,
	MAX_SIGNATURE_PEAK_DECODE_BYTES,
	MAX_SIGNATURE_RETAINED_DECODE_BYTES
} from '$lib/application/documents/signature-asset';
import { COMPLETION_AUDIT_ANCHOR_EVENT_TYPE } from '$lib/domain/audit/catalog';
import type { FieldGeometry, FieldType, Recipient, RecipientStatus } from '$lib/domain/envelope';
import type { DocumentSetManifest } from '$lib/domain/document-set';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import type { DraftDocument } from '$lib/ports/draft-repository';

/**
 * The executed agreement composes the sent originals, every signed value
 * drawn over them, and an evidence appendix into one PDF under the
 * composer's shared page, input, output, object, and image budgets
 * (`pdf-composer.ts`). Discovering that the combination cannot fit only when
 * completion builds it — after every recipient has already signed — is the
 * bug this module closes. Everything a later failure depends on is fixed at
 * send except recipients' values, so the proof is:
 *
 * 1. The appendix is rendered for real from this send's pinned documents,
 *    recipients, and frozen field placements; only values that do not exist
 *    yet are replaced by placeholders at least as long as any real one.
 * 2. The originals and that appendix are composed for real (a dry run), with
 *    the overlay font and image objects reserved so every other object is
 *    numbered and counted at least as high as completion will.
 * 3. What the values can still add is bounded analytically by the composer
 *    itself (`overlayOutputReserve`), from the frozen field placements and
 *    the signature caps enforced at upload (`signature-asset.ts`).
 */

export type SendCompletionBudgetReason =
	PdfCompositionReason | 'too_many_documents' | 'too_many_fields' | 'invalid_field_placement';

export class SendCompletionBudgetError extends Error {
	readonly code = 'SEND_COMPLETION_BUDGET_ERROR';

	constructor(
		readonly reason: SendCompletionBudgetReason,
		message: string
	) {
		super(message);
		this.name = 'SendCompletionBudgetError';
	}
}

/**
 * Placeholders for evidence that only exists at completion. Each has the
 * fixed length of what it stands in for (UUIDv7, SHA-256 hex,
 * `Date#toISOString()`) or exceeds any real value (`MAX_SAFE_INTEGER` for
 * audit counters), and is plain ASCII that the appendix writer never escapes.
 */
const PLACEHOLDER_ID: string = '9'.repeat(36);
const PLACEHOLDER_SHA256: string = 'f'.repeat(64);
const PLACEHOLDER_ISO_DATE: string = '9999-12-31T23:59:59.999Z';
/** Every status a recipient can hold when completion renders the appendix. */
const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
	'pending',
	'viewed',
	'completed',
	'declined'
];
const LONGEST_RECIPIENT_STATUS: RecipientStatus = RECIPIENT_STATUSES.reduce(
	(longest: RecipientStatus, status: RecipientStatus): RecipientStatus =>
		status.length > longest.length ? status : longest
);

export interface WorstCaseEvidenceAppendixInput {
	envelopeId: string;
	title: string;
	sentCommitSha: string;
	draftArchiveSha256: string;
	fieldGeneration: number;
	documentSetHash: string;
	documentSet: DocumentSetManifest;
	markdown: ReadonlyMap<string, DraftDocument>;
	recipients: readonly Recipient[];
	/** The frozen field placements this send pins. */
	fields: readonly CompletionPdfFieldGeometry[];
}

export interface WorstCaseEvidenceAppendix {
	bytes: Uint8Array;
	pageCount: number;
	/**
	 * How many bytes the real appendix can exceed `bytes` by. The real one
	 * carries a subsequence of these lines (only signed fields, possibly
	 * shorter recipient lines), each no longer than here, so its pages and
	 * text never grow; but lines can shift between pages, so each page's
	 * `/Length` and the trailer's `startxref` can gain digits.
	 */
	byteSlack: number;
}

/**
 * Renders the worst-case evidence appendix for *this* send: the real pinned
 * documents, recipients, and frozen field placements through completion's
 * own renderer, with every field assumed signed and every recipient holding
 * the longest status and a decision.
 */
export function computeWorstCaseEvidenceAppendix(
	input: WorstCaseEvidenceAppendixInput
): WorstCaseEvidenceAppendix {
	if (input.fields.length > MAX_MANIFEST_FIELD_COUNT) {
		throw new SendCompletionBudgetError(
			'too_many_fields',
			'The envelope has more fields than a completion manifest can carry.'
		);
	}
	const documents: CompletionManifestDocument[] = input.documentSet.documents.map(
		(leaf): CompletionManifestDocument =>
			leaf.kind === 'pdf'
				? {
						id: leaf.id,
						kind: 'pdf',
						position: leaf.position,
						title: leaf.title,
						sha256: leaf.sha256,
						byteSize: leaf.byteSize,
						pageCount: leaf.pageCount
					}
				: {
						id: leaf.id,
						kind: 'markdown',
						position: leaf.position,
						title: leaf.title,
						path: leaf.path,
						sha256: leaf.contentSha256
					}
	);
	const recipients: CompletionManifestRecipient[] = input.recipients
		.map((recipient: Recipient): CompletionManifestRecipient => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder,
			status: LONGEST_RECIPIENT_STATUS,
			decisionEventId: PLACEHOLDER_ID,
			decisionAt: PLACEHOLDER_ISO_DATE
		}))
		.sort(byId);
	const fields: CompletionManifestField[] = input.fields
		.map((field: CompletionPdfFieldGeometry): CompletionManifestField => ({
			id: field.id,
			fieldType: field.fieldType,
			valueSha256: PLACEHOLDER_SHA256
		}))
		.sort(byId);
	const manifest: CompletionManifestV1 = {
		schema: COMPLETION_MANIFEST_SCHEMA,
		envelopeId: input.envelopeId,
		title: input.title,
		sentCommitSha: input.sentCommitSha,
		draftArchiveSha256: input.draftArchiveSha256,
		fieldGeneration: input.fieldGeneration,
		completedAt: PLACEHOLDER_ISO_DATE,
		documentSetHash: input.documentSetHash,
		documents,
		recipients,
		fields,
		auditProof: {
			anchorEventType: COMPLETION_AUDIT_ANCHOR_EVENT_TYPE,
			anchorEventId: PLACEHOLDER_ID,
			headSequence: Number.MAX_SAFE_INTEGER,
			verifiedEventCount: Number.MAX_SAFE_INTEGER,
			hashChainVerified: true
		}
	};
	const pages: string[][] = buildCompletionPdfPages(
		manifest,
		[...input.markdown.values()],
		input.fields
	);
	const byteSlack: number = (pages.length + 1) * String(MAX_EVIDENCE_SUMMARY_PDF_BYTES).length;
	let bytes: Uint8Array | null = null;
	try {
		bytes = renderCompletionPdf(pages);
	} catch (error: unknown) {
		if (!(error instanceof CompletionPdfBoundExceededError)) throw error;
	}
	if (bytes === null || bytes.byteLength + byteSlack > MAX_EVIDENCE_SUMMARY_PDF_BYTES) {
		throw new SendCompletionBudgetError(
			'output_too_large',
			'The envelope has too much evidence (documents, recipients, or fields) for its completion ' +
				'appendix to stay within the evidence summary budget.'
		);
	}
	return { bytes, pageCount: pages.length, byteSlack };
}

/** Input bytes completion may add for drawn signatures: one capped PNG per signature-like field. */
function reservedSignatureInputBytes(fields: readonly CompletionPdfFieldGeometry[]): number {
	return signatureLikeFieldCount(fields) * MAX_SIGNATURE_ASSET_BYTES;
}

function signatureLikeFieldCount(fields: readonly CompletionPdfFieldGeometry[]): number {
	return fields.filter((field: CompletionPdfFieldGeometry): boolean =>
		isSignatureLike(field.fieldType)
	).length;
}

function isSignatureLike(fieldType: FieldType): boolean {
	return fieldType === 'signature' || fieldType === 'initials';
}

/**
 * Accumulates the sent originals' aggregate page and byte totals, one
 * document at a time, against the composer's shared ceiling minus the
 * measured appendix and the signature images completion may add. Fails
 * closed the instant the running total cannot fit, so a caller that adds a
 * document's already-pinned size before reading its bytes never reads the
 * documents after the one that tipped the budget over.
 */
export class SendCompletionBudgetAccumulator {
	readonly #maxPages: number;
	readonly #maxBytes: number;
	#pages: number = 0;
	#bytes: number = 0;

	constructor(appendix: WorstCaseEvidenceAppendix, fields: readonly CompletionPdfFieldGeometry[]) {
		this.#maxPages = MAX_COMPOSED_PDF_PAGES - appendix.pageCount;
		this.#maxBytes =
			MAX_COMPOSED_PDF_INPUT_BYTES -
			appendix.bytes.byteLength -
			appendix.byteSlack -
			reservedSignatureInputBytes(fields);
	}

	add(pageCount: number, byteSize: number): void {
		this.#pages += pageCount;
		this.#bytes += byteSize;
		if (this.#pages > this.#maxPages) {
			throw new SendCompletionBudgetError(
				'too_many_pages',
				'The envelope documents, together with the evidence appendix they will carry at completion, ' +
					'have more pages than the completed agreement can compose.'
			);
		}
		if (this.#bytes > this.#maxBytes) {
			throw new SendCompletionBudgetError(
				'input_too_large',
				'The envelope documents, together with the evidence appendix and signatures they will carry ' +
					'at completion, are larger than the completed agreement can compose.'
			);
		}
	}
}

export interface SendCompletionOriginal {
	documentId: string;
	position: number;
	pageCount: number;
	bytes: Uint8Array;
}

export interface SendCompletionBudgetInput {
	originals: readonly SendCompletionOriginal[];
	appendix: WorstCaseEvidenceAppendix;
	fields: readonly CompletionPdfFieldGeometry[];
}

/**
 * Text values never draw larger than this (`executed-pdf.ts`
 * `MAX_VALUE_TEXT_SIZE`), and a centered baseline sits at most 0.36 of the
 * size below its box, so no executed-agreement operand exceeds the page's
 * larger displayed side (with the 0.0001 placement tolerance) plus this.
 */
const EXECUTED_TEXT_SIZE_CEILING: number = 18;
/** A checkbox is drawn as one three-point polyline. */
const CHECK_MARK_POINTS: number = 3;

/** The upper bounds the proof established, each already checked against its ceiling. */
export interface SendCompletionBudgetProof {
	inputBytes: number;
	imageWorkingSetBytes: number;
	outputBytes: number;
}

/**
 * Proves that completion can compose this send's executed agreement whatever
 * values recipients later submit within the enforced caps. Runs only after
 * every original has passed the cheap running-total check, and before any of
 * them are persisted as sent objects.
 */
export function validateSendCompletionBudget(
	input: SendCompletionBudgetInput
): SendCompletionBudgetProof {
	if (input.originals.length > MAX_EXECUTED_PDF_DOCUMENTS) {
		throw new SendCompletionBudgetError(
			'too_many_documents',
			'The envelope has more documents than the completed agreement can compose.'
		);
	}
	if (input.fields.length > MAX_MANIFEST_FIELD_COUNT) {
		throw new SendCompletionBudgetError(
			'too_many_fields',
			'The envelope has more fields than a completion manifest can carry.'
		);
	}
	// Completion composes in this order (`buildExecutedPdf`); the dry run must
	// number objects the same way.
	const originals: SendCompletionOriginal[] = [...input.originals].sort(
		(left: SendCompletionOriginal, right: SendCompletionOriginal): number =>
			left.position - right.position || byId({ id: left.documentId }, { id: right.documentId })
	);
	const byDocument: Map<string, SendCompletionOriginal> = new Map(
		originals.map((original: SendCompletionOriginal): [string, SendCompletionOriginal] => [
			original.documentId,
			original
		])
	);
	for (const field of input.fields) assertPlaceable(field, byDocument);

	const imageCount: number = signatureLikeFieldCount(input.fields);
	const hasText: boolean = input.fields.some(
		(field: CompletionPdfFieldGeometry): boolean => field.fieldType !== 'checkbox'
	);
	const operationCount: number = input.fields.length + imageCount;
	if (imageCount > MAX_COMPOSED_PDF_IMAGES) {
		throw budgetError('too_many_images');
	}
	if (operationCount > MAX_COMPOSED_PDF_OVERLAY_OPERATIONS) {
		throw budgetError('too_many_operations');
	}

	let inputBytes: number =
		input.appendix.bytes.byteLength +
		input.appendix.byteSlack +
		imageCount * MAX_SIGNATURE_ASSET_BYTES;
	for (const original of originals) inputBytes += original.bytes.byteLength;
	if (inputBytes > MAX_COMPOSED_PDF_INPUT_BYTES) throw budgetError('input_too_large');
	// The composer holds every source and PNG resident, every earlier decoded
	// image's planes, and the image being decoded (`planImageDecodes`).
	const imageWorkingSetBytes: number =
		imageCount === 0
			? 0
			: inputBytes +
				(imageCount - 1) * MAX_SIGNATURE_RETAINED_DECODE_BYTES +
				MAX_SIGNATURE_PEAK_DECODE_BYTES;
	if (imageWorkingSetBytes > MAX_COMPOSED_PDF_IMAGE_WORKING_SET_BYTES) {
		throw budgetError('decoded_image_budget_exceeded');
	}

	let probe: ComposePdfResult;
	try {
		probe = composePdf({
			sources: [
				...originals.map((original: SendCompletionOriginal) => ({ bytes: original.bytes })),
				{ bytes: input.appendix.bytes }
			],
			maxPages: MAX_EXECUTED_PDF_PAGES,
			maxOutputBytes: MAX_EXECUTED_PDF_BYTES,
			reservedObjectCount: overlayReservedObjectCount(hasText, imageCount)
		});
	} catch (error: unknown) {
		if (error instanceof PdfCompositionError) throw budgetError(error.reason);
		throw error;
	}

	const reserve: number = overlayOutputReserve({
		pages: overlayPages(input.fields, byDocument),
		imageCount,
		maxImageStreamBytes: MAX_SIGNATURE_EMITTED_IMAGE_BYTES
	});
	const outputBytes: number = probe.bytes.byteLength + input.appendix.byteSlack + reserve;
	if (outputBytes > MAX_EXECUTED_PDF_BYTES) throw budgetError('output_too_large');
	return { inputBytes, imageWorkingSetBytes, outputBytes };
}

/**
 * Completion fails closed on a field it cannot place (`buildExecutedPdf`);
 * the placement is frozen now, so that failure is decided now.
 */
function assertPlaceable(
	field: CompletionPdfFieldGeometry,
	byDocument: ReadonlyMap<string, SendCompletionOriginal>
): void {
	const original: SendCompletionOriginal | undefined =
		field.documentId === null ? undefined : byDocument.get(field.documentId);
	const geometry: FieldGeometry | null = field.geometry;
	const placeable: boolean =
		original !== undefined &&
		geometry !== null &&
		Number.isSafeInteger(geometry.page) &&
		geometry.page >= 1 &&
		geometry.page <= original.pageCount &&
		[geometry.x, geometry.y].every(
			(value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1
		) &&
		[geometry.width, geometry.height].every(
			(value: number): boolean => Number.isFinite(value) && value > 0 && value <= 1
		) &&
		geometry.x + geometry.width <= 1.0001 &&
		geometry.y + geometry.height <= 1.0001;
	if (!placeable) {
		throw new SendCompletionBudgetError(
			'invalid_field_placement',
			'A field is not placed on a page of a document in this send.'
		);
	}
}

function overlayPages(
	fields: readonly CompletionPdfFieldGeometry[],
	byDocument: ReadonlyMap<string, SendCompletionOriginal>
): OverlayBudgetPage[] {
	const operationsByPage: Map<
		string,
		{ documentId: string; page: number; operations: OverlayOperationBound[] }
	> = new Map();
	for (const field of fields) {
		const documentId: string = field.documentId as string;
		const page: number = (field.geometry as { page: number }).page;
		const key: string = `${documentId}\u0000${page}`;
		const entry = operationsByPage.get(key) ?? { documentId, page, operations: [] };
		// A signature or initials value is either typed text or a drawn image;
		// reserving both covers whichever the recipient chooses.
		if (field.fieldType === 'checkbox') {
			entry.operations.push({ kind: 'polyline', points: CHECK_MARK_POINTS });
		} else {
			entry.operations.push({ kind: 'text', maxLength: MAX_COMPOSED_PDF_TEXT_LENGTH });
			if (isSignatureLike(field.fieldType)) entry.operations.push({ kind: 'image' });
		}
		operationsByPage.set(key, entry);
	}
	const readers: Map<string, { reader: PdfObjectReader; pages: readonly PdfPageNode[] }> =
		new Map();
	const pages: OverlayBudgetPage[] = [];
	for (const entry of operationsByPage.values()) {
		let source = readers.get(entry.documentId);
		if (source === undefined) {
			const reader: PdfObjectReader = new PdfObjectReader(
				(byDocument.get(entry.documentId) as SendCompletionOriginal).bytes
			);
			try {
				source = { reader, pages: reader.pages() };
			} catch (error: unknown) {
				if (error instanceof PdfPageMetadataError) throw budgetError('invalid_source');
				throw error;
			}
			readers.set(entry.documentId, source);
		}
		const page: PdfPageNode = source.pages[entry.page - 1];
		const size: { width: number; height: number } = displayedSize(page);
		pages.push({
			reader: source.reader,
			page,
			operations: entry.operations,
			maxOperandMagnitude: Math.max(size.width, size.height) * 1.0001 + EXECUTED_TEXT_SIZE_CEILING
		});
	}
	return pages;
}

function budgetError(reason: PdfCompositionReason): SendCompletionBudgetError {
	return new SendCompletionBudgetError(
		reason,
		'The envelope cannot be composed into a completed agreement within the shared composition budget.'
	);
}

function byId(left: { id: string }, right: { id: string }): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
