import type { DraftDocument } from '$lib/ports/draft-repository';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import {
	PDF_CHARS_PER_LINE,
	paginateLines,
	renderDeterministicTextPdf,
	toPdfSafeText,
	wrapPlainTextLines
} from '$lib/adapters/pdf/deterministic-pdf-writer';
import { sha256Hex, type CompletionManifestV1 } from './completion-manifest';

export const COMPLETION_PDF_MANIFEST_SCHEMA: string = 'signkit-completion-pdf-manifest-v1';
export const MAX_COMPLETION_PDF_BYTES: number = 8 * 1024 * 1024;

export class CompletionPdfBoundExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CompletionPdfBoundExceededError';
	}
}

/**
 * A field's placement geometry when available (envelope_field is read
 * independently of the audit-verified evidence — see
 * {@link CompletionPdfFieldGeometry} — and may be absent if that read fails
 * or the field row was since removed; the PDF and its manifest degrade to
 * `null` rather than failing the whole publication closed, since geometry is
 * presentation-only and never affects the manifest's own integrity proof).
 */
export interface CompletionPdfManifestFieldGeometry {
	documentPath: string;
	position: number;
}

export interface CompletionPdfManifestField {
	id: string;
	fieldType: string;
	/** The same signed value digest as the completion manifest — the "ink" reference for this field. */
	inkSha256: string;
	geometry: CompletionPdfManifestFieldGeometry | null;
}

export interface CompletionPdfManifestV1 {
	schema: typeof COMPLETION_PDF_MANIFEST_SCHEMA;
	envelopeId: string;
	/** Pointer back to the completion manifest this PDF was deterministically derived from. */
	manifestSha256: string;
	pdfSha256: string;
	documents: readonly { path: string; sha256: string }[];
	fields: readonly CompletionPdfManifestField[];
	generatedAt: string;
}

/**
 * Builds the plain-text page grid for the completion PDF from already
 * audit-verified manifest data plus the same pinned document content used
 * to build that manifest. Deterministic: identical inputs always produce
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
	lines.push(`Title: ${toPdfSafeText(manifest.title)}`);
	lines.push(`Sent commit: ${manifest.sentCommitSha}`);
	lines.push(`Draft archive SHA-256: ${manifest.draftArchiveSha256}`);
	lines.push(`Field generation: ${manifest.fieldGeneration}`);
	lines.push(`Completed at: ${manifest.completedAt}`);
	lines.push('');

	for (const document of manifest.documents) {
		lines.push('-'.repeat(PDF_CHARS_PER_LINE));
		lines.push(`Document: ${toPdfSafeText(document.path)}`);
		lines.push(`SHA-256: ${document.sha256}`);
		lines.push('-'.repeat(PDF_CHARS_PER_LINE));
		lines.push('');
		const content: DraftDocument | undefined = documentsByPath.get(document.path);
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
		const location: string =
			geometry === undefined
				? 'unplaced'
				: `${toPdfSafeText(geometry.documentPath)}#${geometry.position}`;
		lines.push(`${field.id} | ${field.fieldType} | ink-sha256:${field.valueSha256} | ${location}`);
	}
	lines.push('');

	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	lines.push('Recipients');
	lines.push('-'.repeat(PDF_CHARS_PER_LINE));
	for (const recipient of manifest.recipients) {
		lines.push(
			`${recipient.id} | ${recipient.role} | order ${recipient.routingOrder} | ${recipient.status}` +
				(recipient.decisionEventId === null
					? ''
					: ` | decision ${recipient.decisionEventId} at ${recipient.decisionAt}`)
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
		'Every stored event hash was independently re-derived and the chain verified end-to-end.'
	);
	lines.push(
		'This is not a tamper-proof guarantee against a whole-chain database rewrite; see the'
	);
	lines.push('completion manifest Markdown rendering for the full caveat.');

	return paginateLines(lines);
}

/** Renders the PDF and verifies it against {@link MAX_COMPLETION_PDF_BYTES}. */
export function renderCompletionPdf(pages: readonly (readonly string[])[]): Uint8Array {
	const bytes: Uint8Array = renderDeterministicTextPdf(pages);
	if (bytes.byteLength > MAX_COMPLETION_PDF_BYTES) {
		throw new CompletionPdfBoundExceededError('Completion PDF exceeds the size limit');
	}
	return bytes;
}

export interface BuildCompletionPdfManifestInput {
	manifest: CompletionManifestV1;
	manifestSha256: string;
	pdfBytes: Uint8Array;
	fieldGeometry: readonly CompletionPdfFieldGeometry[];
}

export async function buildCompletionPdfManifest(
	input: BuildCompletionPdfManifestInput
): Promise<CompletionPdfManifestV1> {
	const geometryById = new Map<string, CompletionPdfFieldGeometry>(
		input.fieldGeometry.map((entry: CompletionPdfFieldGeometry) => [entry.id, entry] as const)
	);
	return {
		schema: COMPLETION_PDF_MANIFEST_SCHEMA,
		envelopeId: input.manifest.envelopeId,
		manifestSha256: input.manifestSha256,
		pdfSha256: await sha256Hex(input.pdfBytes),
		documents: input.manifest.documents.map((document) => ({
			path: document.path,
			sha256: document.sha256
		})),
		fields: input.manifest.fields.map((field): CompletionPdfManifestField => {
			const geometry: CompletionPdfFieldGeometry | undefined = geometryById.get(field.id);
			return {
				id: field.id,
				fieldType: field.fieldType,
				inkSha256: field.valueSha256,
				geometry:
					geometry === undefined
						? null
						: { documentPath: geometry.documentPath, position: geometry.position }
			};
		}),
		generatedAt: input.manifest.completedAt
	};
}

/** Deterministic fixed-key JSON, matching the completion manifest's own convention. */
export function canonicalPdfManifestJson(manifest: CompletionPdfManifestV1): string {
	return JSON.stringify(manifest);
}
