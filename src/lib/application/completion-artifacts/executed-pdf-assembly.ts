import { MAX_SENT_PDF_BYTES, sentPdfObjectKey } from '$lib/application/documents/sent-document-pdf';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	signatureAssetKey
} from '$lib/application/documents/signature-asset';
import { fieldTypes, type FieldGeometry, type FieldType } from '$lib/domain/envelope';
import {
	documentSetHash,
	type DocumentSetLeaf,
	type DocumentSetManifest
} from '$lib/domain/document-set';
import type {
	CompletionEvidenceAuditEvent,
	CompletionEvidenceField
} from '$lib/ports/completion-artifact-store';
import { MAX_COMPLETION_AUDIT_VERIFY_EVENTS } from '$lib/ports/completion-artifact-store';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import type {
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import type { ObjectStore } from '$lib/ports/object-store';
import { verifyCompletionAuditChain } from './audit-event-integrity';
import {
	buildExecutedPdf,
	ExecutedPdfIntegrityError,
	parseExecutedFieldValue,
	type ExecutedFieldValue,
	type ExecutedPdfFailureReason,
	type ExecutedPdfDocument,
	type ExecutedPdfField,
	type ExecutedPdfResult
} from './executed-pdf';

/**
 * Turns verified completion evidence into the executed agreement PDF.
 *
 * Nothing here trusts a shortcut: document bytes are read from the immutable
 * objects frozen by the send transaction, never re-rendered from Markdown.
 * Their SQL pointers are reconciled with both the pinned Git document set and
 * the hash-chained `envelope.sent` event before each object is bounded-read and
 * re-hashed. Field placement rows are likewise reconciled exactly with the
 * hash-chained `envelope.fields_placed` event before any geometry is used.
 */

export interface AssembleExecutedAgreementInput {
	objects: ObjectStore;
	organizationId: string;
	envelopeId: string;
	sentCommitSha: string;
	documentSet: DocumentSetManifest;
	sentDocumentSet: SentDocumentSetPointer;
	auditEvents: readonly CompletionEvidenceAuditEvent[];
	fieldGeneration: number;
	/** Field values from the completion evidence, already verified against their digests. */
	fields: readonly CompletionEvidenceField[];
	fieldGeometry: readonly CompletionPdfFieldGeometry[];
	/** Evidence-summary pages to append after the agreement. */
	appendixPdfBytes: Uint8Array;
}

export async function assembleExecutedAgreementPdf(
	input: AssembleExecutedAgreementInput
): Promise<ExecutedPdfResult> {
	await attestExecutedAgreementSources(input);
	const documents: ExecutedPdfDocument[] = [];
	for (const pointer of input.sentDocumentSet.documents) {
		documents.push(await executedDocument(input, pointer));
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
	pointer: SentDocumentPointer
): Promise<ExecutedPdfDocument> {
	if (pointer.byteSize > MAX_SENT_PDF_BYTES) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'A sent document exceeds the immutable PDF size bound'
		);
	}
	const stream: ReadableStream<Uint8Array> | null = await input.objects.get(pointer.objectKey);
	if (stream === null) {
		throw new ExecutedPdfIntegrityError('invalid_document', 'An immutable sent PDF is missing');
	}
	const bytes: Uint8Array = await readStreamBounded(
		stream,
		pointer.byteSize,
		'invalid_document',
		'An immutable sent PDF exceeds its attested byte size'
	);
	if (bytes.byteLength !== pointer.byteSize || (await sha256Hex(bytes)) !== pointer.sha256) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'An immutable sent PDF failed its size or SHA-256 attestation'
		);
	}
	return {
		id: pointer.documentId,
		title: pointer.title,
		position: pointer.position,
		kind: pointer.kind,
		bytes,
		pageCount: pointer.pageCount
	};
}

interface SentAuditDocumentDeclaration {
	id: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
}

interface PlacedFieldDeclaration {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: string | null;
	fieldType: FieldType;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

/**
 * Proves that every mutable SQL projection consumed by PDF composition is the
 * exact projection committed by the already-verified audit chain.
 */
export async function attestExecutedAgreementSources(
	input: AssembleExecutedAgreementInput
): Promise<void> {
	const { payloadsByEventId } = await verifyCompletionAuditChain(
		input.auditEvents,
		{ organizationId: input.organizationId, envelopeId: input.envelopeId },
		MAX_COMPLETION_AUDIT_VERIFY_EVENTS
	);
	const sentEvents: readonly CompletionEvidenceAuditEvent[] = input.auditEvents.filter(
		(event: CompletionEvidenceAuditEvent): boolean => event.eventType === 'envelope.sent'
	);
	if (sentEvents.length !== 1) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'Executed agreement requires exactly one attested send event'
		);
	}
	const sentEvent: CompletionEvidenceAuditEvent = sentEvents[0];
	const sentPayload: Record<string, unknown> = requireRecord(
		payloadsByEventId.get(sentEvent.id),
		'Attested send payload is missing'
	);
	const sentDocuments: readonly SentAuditDocumentDeclaration[] = parseSentDocuments(
		sentPayload.documents
	);
	const pinnedDocumentSetHash: string = await documentSetHash(input.documentSet);
	if (
		sentPayload.commitSha !== input.sentCommitSha ||
		sentPayload.documentSetHash !== pinnedDocumentSetHash ||
		sentPayload.documentSetHash !== input.sentDocumentSet.documentSetHash ||
		sentPayload.documentCount !== sentDocuments.length ||
		input.sentDocumentSet.organizationId !== input.organizationId ||
		input.sentDocumentSet.envelopeId !== input.envelopeId ||
		input.sentDocumentSet.commitSha !== input.sentCommitSha ||
		input.sentDocumentSet.documentSetHash !== sentPayload.documentSetHash ||
		input.sentDocumentSet.documentCount !== sentDocuments.length ||
		input.sentDocumentSet.documents.length !== sentDocuments.length ||
		input.documentSet.documents.length !== sentDocuments.length
	) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'Sent document set does not match the attested send event'
		);
	}
	for (let index: number = 0; index < sentDocuments.length; index += 1) {
		attestSentDocument(
			input,
			input.documentSet.documents[index],
			input.sentDocumentSet.documents[index],
			sentDocuments[index],
			index
		);
	}
	attestFieldPlacements(input, payloadsByEventId, sentEvent);
}

function attestSentDocument(
	input: AssembleExecutedAgreementInput,
	leaf: DocumentSetLeaf,
	pointer: SentDocumentPointer,
	declaration: SentAuditDocumentDeclaration,
	position: number
): void {
	let expectedKey: string;
	try {
		expectedKey = sentPdfObjectKey(input.organizationId, input.envelopeId, pointer.sha256);
	} catch {
		throw new ExecutedPdfIntegrityError('invalid_document', 'Sent PDF key is invalid');
	}
	if (
		pointer.organizationId !== input.organizationId ||
		pointer.envelopeId !== input.envelopeId ||
		pointer.commitSha !== input.sentCommitSha ||
		pointer.position !== position ||
		pointer.documentId !== leaf.id ||
		pointer.documentId !== declaration.id ||
		pointer.kind !== leaf.kind ||
		pointer.title !== leaf.title ||
		pointer.objectKey !== expectedKey ||
		pointer.sha256 !== declaration.sha256 ||
		pointer.byteSize !== declaration.byteSize ||
		pointer.pageCount !== declaration.pageCount ||
		!Number.isSafeInteger(pointer.byteSize) ||
		pointer.byteSize < 1 ||
		pointer.byteSize > MAX_SENT_PDF_BYTES ||
		!Number.isSafeInteger(pointer.pageCount) ||
		pointer.pageCount < 1
	) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'Sent PDF pointer does not match its document and audit attestations'
		);
	}
	if (
		leaf.kind === 'pdf' &&
		(pointer.sha256 !== leaf.sha256 ||
			pointer.byteSize !== leaf.byteSize ||
			pointer.pageCount !== leaf.pageCount)
	) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'Uploaded PDF pointer does not match the pinned Git manifest'
		);
	}
}

function attestFieldPlacements(
	input: AssembleExecutedAgreementInput,
	payloadsByEventId: ReadonlyMap<string, unknown>,
	sentEvent: CompletionEvidenceAuditEvent
): void {
	const placementEvents: readonly CompletionEvidenceAuditEvent[] = input.auditEvents.filter(
		(event: CompletionEvidenceAuditEvent): boolean => event.eventType === 'envelope.fields_placed'
	);
	if (placementEvents.length === 0) {
		if (input.fieldGeneration === 0 && input.fieldGeometry.length === 0) return;
		throw new ExecutedPdfIntegrityError(
			'missing_geometry',
			'Field placement audit history is missing for a non-empty field projection'
		);
	}
	if (
		placementEvents.some(
			(event: CompletionEvidenceAuditEvent): boolean => event.sequence > sentEvent.sequence
		)
	) {
		throw new ExecutedPdfIntegrityError(
			'missing_geometry',
			'Field placement audit history occurs after send'
		);
	}
	const placementEvent: CompletionEvidenceAuditEvent = placementEvents.reduce(
		(
			left: CompletionEvidenceAuditEvent,
			right: CompletionEvidenceAuditEvent
		): CompletionEvidenceAuditEvent => (left.sequence > right.sequence ? left : right)
	);
	const payload: Record<string, unknown> = requireRecord(
		payloadsByEventId.get(placementEvent.id),
		'Attested field placement payload is missing'
	);
	const declarations: readonly PlacedFieldDeclaration[] = parsePlacedFields(payload.fields);
	if (
		payload.commitSha !== input.sentCommitSha ||
		payload.fieldGeneration !== input.fieldGeneration ||
		declarations.length !== input.fieldGeometry.length
	) {
		throw new ExecutedPdfIntegrityError(
			'missing_geometry',
			'Field projection does not match the attested placement generation'
		);
	}
	const declarationsById: Map<string, PlacedFieldDeclaration> = new Map();
	for (const declaration of declarations) {
		if (declarationsById.has(declaration.id)) {
			throw new ExecutedPdfIntegrityError(
				'missing_geometry',
				'Field placement audit event repeats a field identifier'
			);
		}
		declarationsById.set(declaration.id, declaration);
	}
	const seenRows: Set<string> = new Set();
	for (const row of input.fieldGeometry) {
		const declaration: PlacedFieldDeclaration | undefined = declarationsById.get(row.id);
		if (
			seenRows.has(row.id) ||
			declaration === undefined ||
			declaration.recipientId !== row.recipientId ||
			declaration.documentId !== row.documentId ||
			declaration.documentPath !== row.documentPath ||
			declaration.fieldType !== row.fieldType ||
			declaration.required !== row.required ||
			declaration.position !== row.position ||
			!sameGeometry(declaration.geometry, row.geometry)
		) {
			throw new ExecutedPdfIntegrityError(
				'missing_geometry',
				'Field projection differs from its hash-chained placement event'
			);
		}
		seenRows.add(row.id);
	}
}

function parseSentDocuments(value: unknown): readonly SentAuditDocumentDeclaration[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'Attested sent document list is invalid'
		);
	}
	return value.map((candidate: unknown): SentAuditDocumentDeclaration => {
		const entry: Record<string, unknown> = requireRecord(
			candidate,
			'Attested sent document declaration is invalid'
		);
		if (
			typeof entry.id !== 'string' ||
			typeof entry.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			!Number.isSafeInteger(entry.byteSize) ||
			(entry.byteSize as number) < 1 ||
			(entry.byteSize as number) > MAX_SENT_PDF_BYTES ||
			!Number.isSafeInteger(entry.pageCount) ||
			(entry.pageCount as number) < 1
		) {
			throw new ExecutedPdfIntegrityError(
				'invalid_document',
				'Attested sent document declaration is invalid'
			);
		}
		return {
			id: entry.id,
			sha256: entry.sha256,
			byteSize: entry.byteSize as number,
			pageCount: entry.pageCount as number
		};
	});
}

function parsePlacedFields(value: unknown): readonly PlacedFieldDeclaration[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
		throw new ExecutedPdfIntegrityError('missing_geometry', 'Attested field list is invalid');
	}
	return value.map((candidate: unknown): PlacedFieldDeclaration => {
		const entry: Record<string, unknown> = requireRecord(
			candidate,
			'Attested field declaration is invalid'
		);
		const fieldType: unknown = entry.fieldType;
		if (
			typeof entry.id !== 'string' ||
			typeof entry.recipientId !== 'string' ||
			!(
				(typeof entry.documentId === 'string' && entry.documentPath === null) ||
				(entry.documentId === null && typeof entry.documentPath === 'string')
			) ||
			typeof fieldType !== 'string' ||
			!fieldTypes.includes(fieldType as FieldType) ||
			typeof entry.required !== 'boolean' ||
			!Number.isSafeInteger(entry.position)
		) {
			throw new ExecutedPdfIntegrityError(
				'missing_geometry',
				'Attested field declaration is invalid'
			);
		}
		return {
			id: entry.id,
			recipientId: entry.recipientId,
			documentId: entry.documentId as string | null,
			documentPath: entry.documentPath as string | null,
			fieldType: fieldType as FieldType,
			required: entry.required,
			position: entry.position as number,
			geometry: parseGeometry(entry.geometry)
		};
	});
}

function parseGeometry(value: unknown): FieldGeometry | null {
	if (value === null) return null;
	const entry: Record<string, unknown> = requireRecord(value, 'Attested field geometry is invalid');
	if (
		!Number.isSafeInteger(entry.page) ||
		typeof entry.x !== 'number' ||
		typeof entry.y !== 'number' ||
		typeof entry.width !== 'number' ||
		typeof entry.height !== 'number'
	) {
		throw new ExecutedPdfIntegrityError('missing_geometry', 'Attested field geometry is invalid');
	}
	return {
		page: entry.page as number,
		x: entry.x,
		y: entry.y,
		width: entry.width,
		height: entry.height
	};
}

function sameGeometry(left: FieldGeometry | null, right: FieldGeometry | null): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.page === right.page &&
		left.x === right.x &&
		left.y === right.y &&
		left.width === right.width &&
		left.height === right.height
	);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ExecutedPdfIntegrityError('invalid_document', message);
	}
	return value as Record<string, unknown>;
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
		input.organizationId,
		input.envelopeId,
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
	const bytes: Uint8Array = await readStreamBounded(
		stream,
		MAX_SIGNATURE_ASSET_BYTES,
		'missing_signature_asset',
		'A drawn signature asset exceeds its stored size bound'
	);
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
	maximumBytes: number,
	code: ExecutedPdfFailureReason,
	message: string
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
				await reader.cancel(message);
				throw new ExecutedPdfIntegrityError(code, message);
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
