import { describe, expect, it } from 'vitest';
import {
	emittedImageStreamBytes,
	MAX_COMPOSED_PDF_PAGES,
	MAX_COMPOSED_PDF_TEXT_LENGTH
} from '$lib/adapters/pdf/pdf-composer';
import {
	buildFixturePdf,
	textPage,
	type FixturePage
} from '$lib/adapters/pdf/pdf-fixture-test-support';
import { decodePng } from '$lib/adapters/pdf/png-image';
import { encodeTestPng } from '$lib/adapters/pdf/png-image-test-support';
import {
	buildCompletionPdfPages,
	renderCompletionPdf
} from '$lib/application/completion-artifacts/completion-pdf';
import {
	COMPLETION_MANIFEST_SCHEMA,
	type CompletionManifestV1
} from '$lib/application/completion-artifacts/completion-manifest';
import {
	buildExecutedPdf,
	MAX_EXECUTED_PDF_BYTES,
	type ExecutedPdfField
} from '$lib/application/completion-artifacts/executed-pdf';
import {
	MAX_SIGNATURE_ASSET_BYTES,
	MAX_SIGNATURE_EMITTED_IMAGE_BYTES
} from '$lib/application/documents/signature-asset';
import { COMPLETION_AUDIT_ANCHOR_EVENT_TYPE } from '$lib/domain/audit/catalog';
import { appendPdfDocument, type DocumentSetManifest } from '$lib/domain/document-set';
import type { FieldType, Recipient, RecipientStatus } from '$lib/domain/envelope';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import {
	computeWorstCaseEvidenceAppendix,
	SendCompletionBudgetAccumulator,
	SendCompletionBudgetError,
	validateSendCompletionBudget,
	type SendCompletionBudgetProof,
	type SendCompletionOriginal,
	type WorstCaseEvidenceAppendix
} from './send-completion-budget';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const DOCUMENT_A: string = '01900000-0000-7000-8000-00000000000a';
const DOCUMENT_B: string = '01900000-0000-7000-8000-00000000000b';

function uuid(prefix: string, index: number): string {
	return `01900000-0000-7000-8${prefix}-${index.toString().padStart(12, '0')}`;
}

function recipients(count: number, status: RecipientStatus = 'pending'): Recipient[] {
	return Array.from({ length: count }, (_unused: unknown, index: number): Recipient => ({
		id: uuid('001', index),
		envelopeId: ENVELOPE_ID,
		email: `signer-${index}@example.com`,
		name: `Signer ${index}`,
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status
	}));
}

/** 50 fields, the placement limit: 30 signatures, 10 initials, 4 text, 1 date, 5 checkboxes. */
function fieldTypeAt(index: number): FieldType {
	if (index < 30) return 'signature';
	if (index < 40) return 'initials';
	if (index < 44) return 'text';
	if (index < 45) return 'date';
	return 'checkbox';
}

function frozenFields(
	count: number,
	documentPage: number = 2,
	documentPath: (index: number) => string | null = () => null
): CompletionPdfFieldGeometry[] {
	return Array.from({ length: count }, (_unused: unknown, index: number) => {
		const path: string | null = documentPath(index);
		return {
			id: uuid('002', index),
			documentId: path === null ? (index % 2 === 0 ? DOCUMENT_A : DOCUMENT_B) : null,
			documentPath: path,
			position: index,
			recipientId: uuid('001', index % 50),
			fieldType: fieldTypeAt(index),
			required: true,
			geometry: {
				page: documentPage,
				x: 0.02 + (index % 5) * 0.19,
				y: 0.03 + Math.floor(index / 10) * 0.09,
				width: 0.18,
				height: 0.08
			}
		};
	});
}

function documentSet(): DocumentSetManifest {
	let manifest: DocumentSetManifest | null = null;
	for (const [index, id] of [DOCUMENT_A, DOCUMENT_B].entries()) {
		manifest = appendPdfDocument(
			manifest,
			{
				title: `Agreement ${index}`,
				sha256: 'a'.repeat(64),
				byteSize: 1,
				pageCount: 2,
				pageWidth: 612,
				pageHeight: 792
			},
			() => id
		);
	}
	return manifest as DocumentSetManifest;
}

function appendixFor(
	fields: readonly CompletionPdfFieldGeometry[],
	roster: readonly Recipient[] = recipients(50)
): WorstCaseEvidenceAppendix {
	return computeWorstCaseEvidenceAppendix({
		envelopeId: ENVELOPE_ID,
		title: 'Agreement',
		sentCommitSha: '0'.repeat(40),
		draftArchiveSha256: '0'.repeat(64),
		fieldGeneration: 3,
		documentSetHash: 'b'.repeat(64),
		documentSet: documentSet(),
		markdown: new Map(),
		recipients: roster,
		fields
	});
}

/**
 * The appendix completion will actually render for this send once every
 * field is signed and every recipient has decided: same pinned evidence,
 * real-shaped values.
 */
function realAppendix(
	fields: readonly CompletionPdfFieldGeometry[],
	roster: readonly Recipient[],
	signed: (index: number) => boolean
): Uint8Array {
	const manifest: CompletionManifestV1 = {
		schema: COMPLETION_MANIFEST_SCHEMA,
		envelopeId: ENVELOPE_ID,
		title: 'Agreement',
		sentCommitSha: '0'.repeat(40),
		draftArchiveSha256: '0'.repeat(64),
		fieldGeneration: 3,
		completedAt: '2026-10-10T12:34:56.789Z',
		documentSetHash: 'b'.repeat(64),
		documents: documentSet().documents.map((leaf) => ({
			id: leaf.id,
			kind: 'pdf' as const,
			position: leaf.position,
			title: leaf.title,
			sha256: 'a'.repeat(64),
			byteSize: 1,
			pageCount: 2
		})),
		recipients: roster
			.map((recipient: Recipient, index: number) => ({
				id: recipient.id,
				role: recipient.role,
				routingOrder: recipient.routingOrder,
				status: index % 3 === 0 ? ('pending' as const) : ('completed' as const),
				decisionEventId: index % 3 === 0 ? null : uuid('003', index),
				decisionAt: index % 3 === 0 ? null : '2026-10-10T12:00:00.000Z'
			}))
			.sort((left, right) => (left.id < right.id ? -1 : 1)),
		fields: fields
			.filter((_field, index: number) => signed(index))
			.map((field) => ({ id: field.id, fieldType: field.fieldType, valueSha256: 'c'.repeat(64) }))
			.sort((left, right) => (left.id < right.id ? -1 : 1)),
		auditProof: {
			anchorEventType: COMPLETION_AUDIT_ANCHOR_EVENT_TYPE,
			anchorEventId: uuid('004', 1),
			headSequence: 412,
			verifiedEventCount: 412,
			hashChainVerified: true
		}
	};
	return renderCompletionPdf(buildCompletionPdfPages(manifest, [], fields));
}

/** A two-page original: a filler page carrying `paddingBytes` of content, then a text page fields sit on. */
function original(id: string, position: number, paddingBytes: number): SendCompletionOriginal {
	const filler: FixturePage = { content: `%${'x'.repeat(paddingBytes)}\n${textPage(id).content}` };
	return { documentId: id, position, pageCount: 2, bytes: buildFixturePdf([filler, textPage(id)]) };
}

function xorshift(seed: number): () => number {
	let state: number = seed >>> 0 || 1;
	return (): number => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
}

/**
 * Close to the costliest signature the upload caps admit: the canvas raster
 * with sixteen uniformly random opacities over as many rows as still fit
 * the 64 KiB upload, which neither the PNG nor the composer's re-deflated
 * alpha plane can compress below four bits a pixel.
 */
function worstAcceptedSignaturePng(seed: number): Uint8Array {
	const next: () => number = xorshift(seed);
	const pixels: number = 600 * 200;
	const noisyPixels: number = 600 * 170;
	const indices: Uint8Array = new Uint8Array(pixels);
	for (let index: number = 0; index < noisyPixels; index += 1) indices[index] = next() & 0x0f;
	const palette: Uint8Array = new Uint8Array(16 * 3);
	const transparency: Uint8Array = new Uint8Array(16);
	for (let entry: number = 0; entry < 16; entry += 1) {
		palette.set([17, 24, 39], entry * 3);
		transparency[entry] = entry * 17;
	}
	return encodeTestPng({
		width: 600,
		height: 200,
		colorType: 3,
		samples: indices,
		palette,
		transparency
	});
}

/**
 * The longest value the signing API accepts for a text field (4000 UTF-16
 * units): mostly distinct ideographs, so the overlay font subset grows, mixed
 * with PDF string delimiters, astral and lone-surrogate code units.
 */
function worstText(fieldIndex: number): string {
	const pieces: readonly string[] = ['\\', '(', '😀', '\ud800', ')'];
	let value: string = '';
	for (let offset: number = 0; value.length < MAX_COMPOSED_PDF_TEXT_LENGTH; offset += 1) {
		const piece: string =
			offset % 4 === 3
				? pieces[offset % pieces.length]
				: String.fromCodePoint(0x4e00 + ((fieldIndex * 4000 + offset) % 0x5000));
		value += value.length + piece.length <= MAX_COMPOSED_PDF_TEXT_LENGTH ? piece : 'a';
	}
	return value;
}

function worstExecutedFields(fields: readonly CompletionPdfFieldGeometry[]): ExecutedPdfField[] {
	return fields.map((field: CompletionPdfFieldGeometry, index: number): ExecutedPdfField => {
		const base = {
			id: field.id,
			documentId: field.documentId as string,
			fieldType: field.fieldType,
			geometry: field.geometry
		};
		if (field.fieldType === 'signature' || field.fieldType === 'initials') {
			return {
				...base,
				value: { kind: 'drawn-signature', sha256: index.toString(16).padStart(64, '0') },
				signaturePngBytes: worstAcceptedSignaturePng(index + 1)
			};
		}
		if (field.fieldType === 'checkbox')
			return { ...base, value: { kind: 'checkbox', checked: true } };
		if (field.fieldType === 'date') return { ...base, value: { kind: 'text', text: '2026-10-10' } };
		return { ...base, value: { kind: 'text', text: worstText(index) } };
	});
}

describe('computeWorstCaseEvidenceAppendix', () => {
	it('renders the longest final recipient status whatever status the send sees', () => {
		const fields: CompletionPdfFieldGeometry[] = frozenFields(50);
		const pending: WorstCaseEvidenceAppendix = appendixFor(fields, recipients(50, 'pending'));
		const completed: WorstCaseEvidenceAppendix = appendixFor(fields, recipients(50, 'completed'));
		expect(pending.bytes).toEqual(completed.bytes);
	});

	it('bounds the appendix completion actually renders, signed or not, decided or not', () => {
		const fields: CompletionPdfFieldGeometry[] = frozenFields(50);
		const roster: Recipient[] = recipients(50);
		const worst: WorstCaseEvidenceAppendix = appendixFor(fields, roster);
		for (const signed of [() => true, (index: number) => index % 2 === 0, () => false]) {
			const real: Uint8Array = realAppendix(fields, roster, signed);
			expect(real.byteLength).toBeLessThanOrEqual(worst.bytes.byteLength + worst.byteSlack);
		}
	});

	it('measures frozen legacy path scopes rather than a padded placeholder', () => {
		const short: WorstCaseEvidenceAppendix = appendixFor(
			frozenFields(50, 2, () => 'documents/a.md')
		);
		const long: WorstCaseEvidenceAppendix = appendixFor(
			frozenFields(50, 2, (index: number) => `documents/${'nested/'.repeat(60)}${index}.md`)
		);
		expect(long.pageCount).toBeGreaterThan(short.pageCount);
	});

	it('rejects more fields than a completion manifest can carry', () => {
		expect(() => appendixFor(frozenFields(51))).toThrowError(
			expect.objectContaining({ reason: 'too_many_fields' })
		);
	});
});

describe('SendCompletionBudgetAccumulator', () => {
	it('reserves the appendix pages out of the shared page ceiling', () => {
		const appendix: WorstCaseEvidenceAppendix = appendixFor([]);
		const budget = new SendCompletionBudgetAccumulator(appendix, []);
		budget.add(MAX_COMPOSED_PDF_PAGES - appendix.pageCount, 1);
		expect(() => budget.add(1, 1)).toThrowError(
			expect.objectContaining({ reason: 'too_many_pages' })
		);
	});

	it('reserves one capped PNG of input per signature-like field', () => {
		const appendix: WorstCaseEvidenceAppendix = appendixFor([]);
		const withoutFields = new SendCompletionBudgetAccumulator(appendix, []);
		const withSignatures = new SendCompletionBudgetAccumulator(appendix, frozenFields(40));
		const room: number =
			32 * 1024 * 1024 -
			appendix.bytes.byteLength -
			appendix.byteSlack -
			40 * MAX_SIGNATURE_ASSET_BYTES;
		expect(() => withoutFields.add(1, room + 1)).not.toThrow();
		expect(() => withSignatures.add(1, room + 1)).toThrowError(
			expect.objectContaining({ reason: 'input_too_large' })
		);
	});
});

describe('validateSendCompletionBudget', () => {
	const fields: CompletionPdfFieldGeometry[] = frozenFields(50);
	const appendix: WorstCaseEvidenceAppendix = appendixFor(fields);

	it.each([
		['an unknown document', { documentId: uuid('009', 9) }],
		['a page past the document', { geometry: { page: 3, x: 0, y: 0, width: 0.1, height: 0.1 } }],
		['no geometry', { geometry: null }],
		['a box past the page edge', { geometry: { page: 1, x: 0.95, y: 0, width: 0.1, height: 0.1 } }]
	])('rejects a field with %s, which completion could not draw', (_label, override) => {
		const misplaced: CompletionPdfFieldGeometry[] = [
			{ ...fields[0], ...override },
			...fields.slice(1)
		];
		expect(() =>
			validateSendCompletionBudget({
				originals: [original(DOCUMENT_A, 0, 0), original(DOCUMENT_B, 1, 0)],
				appendix,
				fields: misplaced
			})
		).toThrowError(expect.objectContaining({ reason: 'invalid_field_placement' }));
	});

	it('rejects originals whose pages leave no room for the appendix', () => {
		const pages = (count: number): Uint8Array =>
			buildFixturePdf(
				Array.from({ length: count }, (_unused, index: number) => textPage(`p${index}`))
			);
		expect(() =>
			validateSendCompletionBudget({
				originals: [
					{ documentId: DOCUMENT_A, position: 0, pageCount: 400, bytes: pages(400) },
					{ documentId: DOCUMENT_B, position: 1, pageCount: 400, bytes: pages(400) }
				],
				appendix,
				fields: []
			})
		).toThrowError(expect.objectContaining({ reason: 'too_many_pages' }));
	});

	it(
		'accepts originals at the output boundary only when the worst signed agreement really fits',
		{ timeout: 120_000 },
		() => {
			const roster: Recipient[] = recipients(50);
			const small: SendCompletionBudgetProof = validateSendCompletionBudget({
				originals: [original(DOCUMENT_A, 0, 0), original(DOCUMENT_B, 1, 0)],
				appendix,
				fields
			});
			// Padding is copied byte-for-byte, so the bound grows by the padding
			// plus at most a few `/Length` and offset digits.
			const room: number = MAX_EXECUTED_PDF_BYTES - small.outputBytes - 64;
			const half: number = Math.floor(room / 2);
			const originals: SendCompletionOriginal[] = [
				original(DOCUMENT_A, 0, half),
				original(DOCUMENT_B, 1, room - half)
			];
			const proof: SendCompletionBudgetProof = validateSendCompletionBudget({
				originals,
				appendix,
				fields
			});
			expect(proof.outputBytes).toBeLessThanOrEqual(MAX_EXECUTED_PDF_BYTES);

			const executedFields: ExecutedPdfField[] = worstExecutedFields(fields);
			for (const field of executedFields) {
				if (field.signaturePngBytes === undefined) continue;
				expect(field.signaturePngBytes.byteLength).toBeLessThanOrEqual(MAX_SIGNATURE_ASSET_BYTES);
				expect(emittedImageStreamBytes(decodePng(field.signaturePngBytes))).toBeLessThanOrEqual(
					MAX_SIGNATURE_EMITTED_IMAGE_BYTES
				);
			}
			const executed = buildExecutedPdf({
				documents: originals.map((entry: SendCompletionOriginal) => ({
					id: entry.documentId,
					title: entry.documentId,
					position: entry.position,
					kind: 'pdf' as const,
					bytes: entry.bytes,
					pageCount: entry.pageCount
				})),
				fields: executedFields,
				appendixPdfBytes: realAppendix(fields, roster, () => true)
			});
			expect(executed.renderedFieldCount).toBe(50);
			expect(executed.bytes.byteLength).toBeLessThanOrEqual(proof.outputBytes);

			expect(() =>
				validateSendCompletionBudget({
					originals: [original(DOCUMENT_A, 0, half + 256), original(DOCUMENT_B, 1, room - half)],
					appendix,
					fields
				})
			).toThrowError(expect.objectContaining({ reason: 'output_too_large' }));
		}
	);

	it('executes a text field holding the longest value the signing API accepts', () => {
		const field: CompletionPdfFieldGeometry = { ...fields[40], documentId: DOCUMENT_A };
		expect(field.fieldType).toBe('text');
		const value: string = worstText(40);
		expect(value.length).toBe(4000);
		const document: SendCompletionOriginal = original(DOCUMENT_A, 0, 0);
		const proof: SendCompletionBudgetProof = validateSendCompletionBudget({
			originals: [document],
			appendix: appendixFor([field]),
			fields: [field]
		});

		const executed = buildExecutedPdf({
			documents: [
				{
					id: DOCUMENT_A,
					title: 'Agreement',
					position: 0,
					kind: 'pdf',
					bytes: document.bytes,
					pageCount: 2
				}
			],
			fields: [
				{
					id: field.id,
					documentId: DOCUMENT_A,
					fieldType: 'text',
					geometry: field.geometry,
					value: { kind: 'text', text: value }
				}
			],
			appendixPdfBytes: realAppendix([field], recipients(50), () => true)
		});
		expect(executed.renderedFieldCount).toBe(1);
		expect(executed.bytes.byteLength).toBeLessThanOrEqual(proof.outputBytes);
	});

	it('surfaces a composition failure as a budget error, not a render failure', () => {
		expect(() =>
			validateSendCompletionBudget({
				originals: [
					{ documentId: DOCUMENT_A, position: 0, pageCount: 1, bytes: new Uint8Array(10) }
				],
				appendix,
				fields: []
			})
		).toThrowError(SendCompletionBudgetError);
	});
});
