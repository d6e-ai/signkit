import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import {
	renderSentDocumentLeaf,
	type RenderedSentDocument
} from '$lib/application/documents/sent-document-pdf';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	signatureAssetKey
} from '$lib/application/documents/signature-asset';
import type { DocumentSetLeaf, DocumentSetManifest } from '$lib/domain/document-set';
import type { DraftDocument } from '$lib/ports/draft-repository';
import type { CompletionEvidenceField } from '$lib/ports/completion-artifact-store';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import type { ObjectStore } from '$lib/ports/object-store';
import {
	buildExecutedPdf,
	ExecutedPdfIntegrityError,
	parseExecutedFieldValue,
	type ExecutedFieldValue,
	type ExecutedPdfDocument,
	type ExecutedPdfField,
	type ExecutedPdfResult
} from './executed-pdf';

/**
 * Turns verified completion evidence into the executed agreement PDF.
 *
 * Nothing here trusts a shortcut: document bytes are re-derived from the
 * pinned revision through the same renderer that served them (so an uploaded
 * original is re-checked against its manifest digest), each drawn signature is
 * fetched from its content-addressed key and re-hashed, and every signed value
 * must have complete frozen geometry in the field projection. A value that
 * cannot be placed faithfully fails publication rather than vanishing from the
 * agreement.
 */

export interface AssembleExecutedAgreementInput {
	objects: ObjectStore;
	revision: ImmutableDraftRevision;
	documentSet: DocumentSetManifest;
	markdown: ReadonlyMap<string, DraftDocument>;
	/** Field values from the completion evidence, already verified against their digests. */
	fields: readonly CompletionEvidenceField[];
	fieldGeometry: readonly CompletionPdfFieldGeometry[];
	/** Evidence-summary pages to append after the agreement. */
	appendixPdfBytes: Uint8Array;
}

export async function assembleExecutedAgreementPdf(
	input: AssembleExecutedAgreementInput
): Promise<ExecutedPdfResult> {
	const documents: ExecutedPdfDocument[] = [];
	for (const leaf of input.documentSet.documents) {
		documents.push(await executedDocument(input, leaf));
	}

	const geometryById: Map<string, CompletionPdfFieldGeometry> = new Map(
		input.fieldGeometry.map(
			(entry: CompletionPdfFieldGeometry): [string, CompletionPdfFieldGeometry] => [entry.id, entry]
		)
	);
	const signatureCache: Map<string, Uint8Array> = new Map();
	const fields: ExecutedPdfField[] = [];
	for (const field of input.fields) {
		const value: ExecutedFieldValue = parseExecutedFieldValue(field.fieldType, field.valueJson);
		if (value.kind === 'empty') continue;
		const placement: CompletionPdfFieldGeometry | undefined = geometryById.get(field.id);
		if (placement === undefined) {
			throw new ExecutedPdfIntegrityError(
				'missing_geometry',
				'A signed field has no placement row in the field projection'
			);
		}
		if (placement.documentId === null) {
			throw new ExecutedPdfIntegrityError(
				'unknown_document',
				'A signed field is not scoped to a document in the sent document set'
			);
		}
		const executed: ExecutedPdfField = {
			id: field.id,
			documentId: placement.documentId,
			fieldType: field.fieldType,
			geometry: placement.geometry,
			value
		};
		if (value.kind === 'drawn-signature') {
			executed.signaturePngBytes = await readSignatureAsset(
				input,
				placement.recipientId,
				value.sha256,
				signatureCache
			);
		}
		fields.push(executed);
	}

	return buildExecutedPdf({
		documents,
		fields,
		appendixPdfBytes: input.appendixPdfBytes
	});
}

async function executedDocument(
	input: AssembleExecutedAgreementInput,
	leaf: DocumentSetLeaf
): Promise<ExecutedPdfDocument> {
	const rendered: RenderedSentDocument = await renderSentDocumentLeaf(
		input.objects,
		input.revision,
		input.markdown,
		leaf
	);
	return {
		id: rendered.documentId,
		title: rendered.title,
		position: rendered.position,
		kind: rendered.kind,
		bytes: rendered.bytes,
		pageCount: rendered.pageCount
	};
}

/**
 * Reads one drawn signature from the recipient-scoped, content-addressed key
 * it was written to and proves the bytes are the ones the field value names.
 * A missing, oversized, or mismatched asset is an integrity failure: the
 * alternative is an "executed" agreement with a blank signature box.
 */
async function readSignatureAsset(
	input: AssembleExecutedAgreementInput,
	recipientId: string,
	sha256: string,
	cache: Map<string, Uint8Array>
): Promise<Uint8Array> {
	const key: string = signatureAssetKey(
		input.revision.organizationId,
		input.revision.envelopeId,
		recipientId,
		sha256
	);
	const cached: Uint8Array | undefined = cache.get(key);
	if (cached !== undefined) return cached;
	const stream: ReadableStream<Uint8Array> | null = await input.objects.get(key);
	if (stream === null) {
		throw new ExecutedPdfIntegrityError(
			'missing_signature_asset',
			'A drawn signature asset is missing from the object store'
		);
	}
	const bytes: Uint8Array = await readStreamBounded(stream, MAX_SIGNATURE_ASSET_BYTES);
	if ((await sha256Hex(bytes)) !== sha256) {
		throw new ExecutedPdfIntegrityError(
			'missing_signature_asset',
			'A drawn signature asset failed SHA-256 verification'
		);
	}
	cache.set(key, bytes);
	return bytes;
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number
): Promise<Uint8Array> {
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		for (;;) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				await reader.cancel('signature asset exceeds its bound');
				throw new ExecutedPdfIntegrityError(
					'missing_signature_asset',
					'A drawn signature asset exceeds its stored size bound'
				);
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
