import type { DraftDocument } from '$lib/ports/draft-repository';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import {
	PDF_CHARS_PER_LINE,
	paginateLines,
	renderDeterministicTextPdf,
	toPdfSafeText,
	wrapPlainTextLines
} from '$lib/adapters/pdf/deterministic-pdf-writer';
import {
	CompletionArtifactIntegrityError,
	sha256Hex,
	type CompletionManifestV1
} from './completion-manifest';
import { MAX_EVIDENCE_SUMMARY_PDF_BYTES } from './completion-pdf-limits';

export const COMPLETION_PDF_MANIFEST_SCHEMA: string = 'signkit-completion-pdf-manifest-v2';

export class CompletionPdfBoundExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CompletionPdfBoundExceededError';
	}
}

/**
 * What the published PDF artifact actually is.
 *
 * `executed-agreement-v1` is the signed agreement: the sent document set in
 * document order with every signed value drawn at its frozen geometry, then
 * the evidence summary as an appendix. `evidence-summary-v1` is the older
 * evidence-only rendering, still produced for envelopes sent before
 * per-document sends existed, whose fields are scoped to a Markdown path and
 * carry no geometry to execute against.
 */
export type CompletionPdfArtifactKind = 'executed-agreement-v1' | 'evidence-summary-v1';

/** A field's frozen placement, as published alongside the executed PDF. */
export interface CompletionPdfManifestFieldGeometry {
	documentId: string | null;
	documentPath: string | null;
	position: number;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CompletionPdfManifestField {
	id: string;
	fieldType: string;
	/** The same signed value digest as the completion manifest — the "ink" reference for this field. */
	inkSha256: string;
	geometry: CompletionPdfManifestFieldGeometry | null;
}

export interface CompletionPdfManifestDocument {
	path?: string;
	sha256: string;
	/** 1-based inclusive page range in the executed PDF, when one was produced. */
	firstPage?: number;
	lastPage?: number;
}

export interface CompletionPdfManifestV2 {
	schema: typeof COMPLETION_PDF_MANIFEST_SCHEMA;
	artifactKind: CompletionPdfArtifactKind;
	envelopeId: string;
	/** Pointer back to the completion manifest this PDF was deterministically derived from. */
	manifestSha256: string;
	pdfSha256: string;
	pageCount: number;
	/** First page of the evidence appendix inside the executed PDF, when there is one. */
	appendixFirstPage: number | null;
	documents: readonly CompletionPdfManifestDocument[];
	fields: readonly CompletionPdfManifestField[];
	generatedAt: string;
}

/**
 * Builds the plain-text page grid for the completion evidence summary from
 * already audit-verified manifest data plus the same pinned document content
 * used to build that manifest. Deterministic: identical inputs always produce
 * identical pages, and therefore identical PDF bytes.
 */
export function buildCompletionPdfPages(
	manifest: CompletionManifestV1,
	documents: readonly DraftDocument[],
	fieldGeometry: readonly CompletionPdfFieldGeometry[]
): string[][] {
	const geometryById = new Map<string, CompletionPdfFieldGeometry>(
		fieldGeometry.map((entry: CompletionPdfFieldGeometry) => [entry.id, entry] as const)
	);
	const documentsByPath = new Map<string, DraftDocument>(
		documents.map((document: DraftDocument) => [document.path, document] as const)
	);

	const lines: string[] = [];
	lines.push('SignKit Completion Evidence');
	lines.push('='.repeat(27));
	lines.push('');
	lines.push(`Envelope ID: ${manifest.envelopeId}`);
	lines.push(...wrapPlainTextLines(`Title: ${toPdfSafeText(manifest.title)}`, PDF_CHARS_PER_LINE));
	lines.push(`Sent commit: ${manifest.sentCommitSha}`);
	lines.push(
		...wrapPlainTextLines(
			`Draft archive SHA-256: ${manifest.draftArchiveSha256}`,
			PDF_CHARS_PER_LINE
		)
	);
	lines.push(`Field generation: ${manifest.fieldGeneration}`);
	lines.push(`Completed at: ${manifest.completedAt}`);
	if (manifest.documentSetHash !== undefined) {
		lines.push(
			...wrapPlainTextLines(`Document set hash: ${manifest.documentSetHash}`, PDF_CHARS_PER_LINE)
		);
	}
	lines.push('');

	for (const document of manifest.documents) {
		lines.push('-'.repeat(PDF_CHARS_PER_LINE));
		if (document.kind === 'pdf') {
			lines.push(
				...wrapPlainTextLines(
					`Document: ${toPdfSafeText(document.title ?? document.id ?? 'PDF')}`,
					PDF_CHARS_PER_LINE
				)
			);
			lines.push('Kind: pdf');
			if (document.pageCount !== undefined) lines.push(`Pages: ${document.pageCount}`);
			lines.push(...wrapPlainTextLines(`SHA-256: ${document.sha256}`, PDF_CHARS_PER_LINE));
			if (document.byteSize !== undefined) lines.push(`Size: ${document.byteSize} bytes`);
			lines.push('-'.repeat(PDF_CHARS_PER_LINE));
			lines.push('');
			continue;
		}
		lines.push(
			...wrapPlainTextLines(
				`Document: ${toPdfSafeText(document.path ?? document.title ?? 'Document')}`,
				PDF_CHARS_PER_LINE
			)
		);
		lines.push(...wrapPlainTextLines(`SHA-256: ${document.sha256}`, PDF_CHARS_PER_LINE));
		lines.push('-'.repeat(PDF_CHARS_PER_LINE));
		lines.push('');
		const content: DraftDocument | undefined =
			document.path === undefined ? undefined : documentsByPath.get(document.path);
		if (content !== undefined) {
			lines.push(...wrapPlainTextLines(toPdfSafeText(content.content), PDF_CHARS_PER_LINE));
		}
		lines.push('');
	}

	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	lines.push('Fields (ink references)');
	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	for (const field of manifest.fields) {
		const geometry: CompletionPdfFieldGeometry | undefined = geometryById.get(field.id);
		lines.push(
			...wrapPlainTextLines(
				`${field.id} | ${field.fieldType} | ink-sha256:${field.valueSha256} | ${fieldLocation(geometry)}`,
				PDF_CHARS_PER_LINE
			)
		);
	}
	lines.push('');

	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	lines.push('Recipients');
	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	for (const recipient of manifest.recipients) {
		lines.push(
			...wrapPlainTextLines(
				`${recipient.id} | ${recipient.role} | order ${recipient.routingOrder} | ${recipient.status}` +
					(recipient.decisionEventId === null
						? ''
						: ` | decision ${recipient.decisionEventId} at ${recipient.decisionAt}`),
				PDF_CHARS_PER_LINE
			)
		);
	}
	lines.push('');

	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	lines.push('Audit proof');
	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	lines.push(`Anchor event type: ${manifest.auditProof.anchorEventType}`);
	lines.push(`Anchor event ID: ${manifest.auditProof.anchorEventId}`);
	lines.push(`Head sequence: ${manifest.auditProof.headSequence}`);
	lines.push(`Verified event count: ${manifest.auditProof.verifiedEventCount}`);
	lines.push(
		...wrapPlainTextLines(
			'Every stored event hash was independently re-derived and the chain verified ' +
				'end-to-end. This is not a tamper-proof guarantee against a whole-chain database ' +
				'rewrite; see the completion manifest Markdown rendering for the full caveat.',
			PDF_CHARS_PER_LINE
		)
	);

	return paginateLines(lines);
}

/** Where a field sits, in the document-order and unit-square terms the evidence records. */
function fieldLocation(geometry: CompletionPdfFieldGeometry | undefined): string {
	if (geometry === undefined) return 'unplaced';
	const scope: string = toPdfSafeText(geometry.documentPath ?? geometry.documentId ?? 'unplaced');
	const placement: string =
		geometry.geometry === null
			? ''
			: ` page ${geometry.geometry.page} at ${round(geometry.geometry.x)},${round(geometry.geometry.y)}` +
				` size ${round(geometry.geometry.width)}x${round(geometry.geometry.height)}`;
	return `${scope}#${geometry.position}${placement}`;
}

function round(value: number): string {
	return (Math.round(value * 1e4) / 1e4).toString();
}

/** Renders the evidence summary and verifies it against its appendix-specific bound. */
export function renderCompletionPdf(pages: readonly (readonly string[])[]): Uint8Array {
	const bytes: Uint8Array = renderDeterministicTextPdf(pages);
	if (bytes.byteLength > MAX_EVIDENCE_SUMMARY_PDF_BYTES) {
		throw new CompletionPdfBoundExceededError('Completion PDF exceeds the size limit');
	}
	return bytes;
}

export interface BuildCompletionPdfManifestInput {
	manifest: CompletionManifestV1;
	manifestSha256: string;
	pdfBytes: Uint8Array;
	fieldGeometry: readonly CompletionPdfFieldGeometry[];
	artifactKind: CompletionPdfArtifactKind;
	pageCount: number;
	appendixFirstPage?: number | null;
	/** Page ranges of each document inside the executed PDF, keyed by document ID. */
	documentPages?: ReadonlyMap<string, { firstPage: number; lastPage: number }>;
}

export async function buildCompletionPdfManifest(
	input: BuildCompletionPdfManifestInput
): Promise<CompletionPdfManifestV2> {
	const geometryById = new Map<string, CompletionPdfFieldGeometry>(
		input.fieldGeometry.map((entry: CompletionPdfFieldGeometry) => [entry.id, entry] as const)
	);
	const executed: boolean = input.artifactKind === 'executed-agreement-v1';
	return {
		schema: COMPLETION_PDF_MANIFEST_SCHEMA,
		artifactKind: input.artifactKind,
		envelopeId: input.manifest.envelopeId,
		manifestSha256: input.manifestSha256,
		pdfSha256: await sha256Hex(input.pdfBytes),
		pageCount: input.pageCount,
		appendixFirstPage: input.appendixFirstPage ?? null,
		documents: input.manifest.documents.map((document): CompletionPdfManifestDocument => {
			const pages = document.id === undefined ? undefined : input.documentPages?.get(document.id);
			return {
				...(document.path === undefined ? {} : { path: document.path }),
				sha256: document.sha256,
				...(pages === undefined ? {} : { firstPage: pages.firstPage, lastPage: pages.lastPage })
			};
		}),
		fields: input.manifest.fields.map((field): CompletionPdfManifestField => {
			const placement: CompletionPdfFieldGeometry | undefined = geometryById.get(field.id);
			// The executed agreement is only meaningful if every field it claims
			// to carry was placed somewhere provable, so a gap here fails the
			// publication rather than publishing a null.
			if (executed && (placement === undefined || placement.geometry === null)) {
				throw new CompletionArtifactIntegrityError(
					'Executed agreement PDF is missing frozen geometry for a signed field'
				);
			}
			return {
				id: field.id,
				fieldType: field.fieldType,
				inkSha256: field.valueSha256,
				geometry:
					placement === undefined || placement.geometry === null
						? null
						: {
								documentId: placement.documentId,
								documentPath: placement.documentPath,
								position: placement.position,
								page: placement.geometry.page,
								x: placement.geometry.x,
								y: placement.geometry.y,
								width: placement.geometry.width,
								height: placement.geometry.height
							}
			};
		}),
		generatedAt: input.manifest.completedAt
	};
}

/** Deterministic fixed-key JSON, matching the completion manifest's own convention. */
export function canonicalPdfManifestJson(manifest: CompletionPdfManifestV2): string {
	return JSON.stringify(manifest);
}
