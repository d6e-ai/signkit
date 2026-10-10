import type { DocumentSetLeaf, DocumentSetManifest } from './document-set';
import type { MarkdownPath } from './envelope';

export const REVISION_DIFF_SCHEMA = 'signkit-revision-diff-v1' as const;

export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_FILES = 50;

/**
 * Upper bound on LCS matrix cells (old-line-count * new-line-count). A
 * two-sided 512KB document could hold hundreds of thousands of single-
 * character lines each, so an unbounded LCS would allocate gigabytes and
 * burn unbounded CPU. Above this bound, computeLineDiff falls back to a
 * deterministic whole-file replacement instead of a line-matched diff.
 */
const MAX_LCS_MATRIX_CELLS = 4_000_000;

const TRUNCATION_MARKER = '\n[diff truncated: exceeded byte limit]\n';

export type DocumentChangeType = 'added' | 'removed' | 'modified' | 'unchanged';

export interface DocumentTitleDiff {
	current: string;
	previous?: string;
	changed: boolean;
}

export interface DocumentPositionDiff {
	current?: number;
	previous?: number;
	changed: boolean;
}

export interface DocumentContentDiff {
	changed: boolean;
	previousSha256?: string;
	currentSha256?: string;
	unifiedDiff?: string;
	additions: number;
	deletions: number;
	truncated?: boolean;
}

export interface DocumentPdfDetailsDiff {
	previousByteSize?: number;
	currentByteSize?: number;
	previousPageCount?: number;
	currentPageCount?: number;
	previousPageWidth?: number;
	currentPageWidth?: number;
	previousPageHeight?: number;
	currentPageHeight?: number;
}

export interface DocumentChange {
	documentId: string;
	kind: 'markdown' | 'pdf';
	path?: MarkdownPath;
	/** Previous Markdown path, present only when the document was renamed. */
	previousPath?: MarkdownPath;
	pathChanged: boolean;
	changeType: DocumentChangeType;
	addition: boolean;
	removal: boolean;
	titleChanged: boolean;
	orderChanged: boolean;
	contentChanged: boolean;
	title: DocumentTitleDiff;
	position: DocumentPositionDiff;
	content: DocumentContentDiff;
	pdf?: DocumentPdfDetailsDiff;
}

export interface RevisionDiffSummary {
	documentsAdded: number;
	documentsRemoved: number;
	documentsModified: number;
	documentsReordered: number;
	titlesChanged: number;
	totalChanges: number;
}

export interface RevisionDiffResult {
	schema: typeof REVISION_DIFF_SCHEMA;
	base: {
		generation: number;
		commitSha: string | null;
	};
	head: {
		generation: number;
		commitSha: string | null;
		message?: string | null;
	};
	summary: RevisionDiffSummary;
	changes: readonly DocumentChange[];
	unifiedText: string;
	truncated: boolean;
	truncationReason?: 'diff_bytes_limit' | 'file_count_limit';
}

export interface GenerateDiffOptions {
	includeUnified?: boolean;
	maxDiffBytes?: number;
	maxFiles?: number;
	contextLines?: number;
}

interface DiffLine {
	type: 'context' | 'addition' | 'deletion';
	text: string;
}

interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: DiffLine[];
}

function textLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split('\n');
	if (text.endsWith('\n')) lines.pop();
	return lines;
}

/**
 * Computes an edit script of additions, deletions, and context lines between two texts.
 */
export function computeLineDiff(
	oldText: string,
	newText: string
): {
	lines: DiffLine[];
	additions: number;
	deletions: number;
} {
	if (oldText === newText) {
		return {
			lines: textLines(oldText).map((text) => ({ type: 'context', text })),
			additions: 0,
			deletions: 0
		};
	}

	const oldLines = textLines(oldText);
	const newLines = textLines(newText);

	if (oldLines.length === 0) {
		return {
			lines: newLines.map((text) => ({ type: 'addition', text })),
			additions: newLines.length,
			deletions: 0
		};
	}

	if (newLines.length === 0) {
		return {
			lines: oldLines.map((text) => ({ type: 'deletion', text })),
			additions: 0,
			deletions: oldLines.length
		};
	}

	const m = oldLines.length;
	const n = newLines.length;

	if (m * n > MAX_LCS_MATRIX_CELLS) {
		// Deterministic safe fallback: represent the whole file as a
		// replacement (all old lines removed, all new lines added) rather
		// than paying for an unbounded LCS matrix. Still correct output,
		// just without line-level matching inside the replaced region.
		return {
			lines: [
				...oldLines.map((text): DiffLine => ({ type: 'deletion', text })),
				...newLines.map((text): DiffLine => ({ type: 'addition', text }))
			],
			additions: newLines.length,
			deletions: oldLines.length
		};
	}

	// Compute LCS via standard matrix (bounded size, checked above)
	const dp: Int32Array = new Int32Array((m + 1) * (n + 1));
	const stride = n + 1;

	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			if (oldLines[i] === newLines[j]) {
				dp[(i + 1) * stride + (j + 1)] = dp[i * stride + j] + 1;
			} else {
				const left = dp[(i + 1) * stride + j];
				const up = dp[i * stride + (j + 1)];
				dp[(i + 1) * stride + (j + 1)] = left > up ? left : up;
			}
		}
	}

	// Backtrack to assemble edit script
	const rawScript: DiffLine[] = [];
	let i = m;
	let j = n;
	let additions = 0;
	let deletions = 0;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			rawScript.push({ type: 'context', text: oldLines[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
			rawScript.push({ type: 'addition', text: newLines[j - 1] });
			additions++;
			j--;
		} else if (i > 0 && (j === 0 || dp[i * stride + (j - 1)] < dp[(i - 1) * stride + j])) {
			rawScript.push({ type: 'deletion', text: oldLines[i - 1] });
			deletions++;
			i--;
		}
	}

	rawScript.reverse();
	return { lines: rawScript, additions, deletions };
}

/**
 * Creates unified diff hunks from an edit script.
 */
export function buildUnifiedHunks(
	editLines: readonly DiffLine[],
	contextLines: number = 3
): DiffHunk[] {
	if (editLines.length === 0) return [];
	if (!editLines.some((l) => l.type !== 'context')) return [];

	const hunks: DiffHunk[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;

	let currentHunk: DiffHunk | null = null;
	let trailingContext = 0;

	for (let idx = 0; idx < editLines.length; idx++) {
		const line = editLines[idx];
		const isChange = line.type !== 'context';

		if (isChange) {
			if (currentHunk === null) {
				// Start new hunk, grab preceding context
				const contextStart = Math.max(0, idx - contextLines);
				const leadingLines: DiffLine[] = [];
				let hunkOldStart = oldLineNum;
				let hunkNewStart = newLineNum;

				for (let c = contextStart; c < idx; c++) {
					leadingLines.push(editLines[c]);
				}
				hunkOldStart -= leadingLines.length;
				hunkNewStart -= leadingLines.length;

				currentHunk = {
					oldStart: Math.max(1, hunkOldStart),
					oldCount: leadingLines.length,
					newStart: Math.max(1, hunkNewStart),
					newCount: leadingLines.length,
					lines: [...leadingLines]
				};
			}

			currentHunk.lines.push(line);
			if (line.type === 'deletion') currentHunk.oldCount++;
			if (line.type === 'addition') currentHunk.newCount++;
			trailingContext = 0;
		} else {
			// Context line
			if (currentHunk !== null) {
				trailingContext++;
				currentHunk.lines.push(line);
				currentHunk.oldCount++;
				currentHunk.newCount++;

				// Check if hunk should close (look ahead to see if another change is within 2 * contextLines)
				let nextChangeDistance = -1;
				for (
					let next = idx + 1;
					next < Math.min(editLines.length, idx + contextLines * 2 + 1);
					next++
				) {
					if (editLines[next].type !== 'context') {
						nextChangeDistance = next - idx;
						break;
					}
				}

				if (trailingContext >= contextLines && nextChangeDistance === -1) {
					// Close hunk
					hunks.push(currentHunk);
					currentHunk = null;
					trailingContext = 0;
				}
			}
		}

		if (line.type === 'context' || line.type === 'deletion') oldLineNum++;
		if (line.type === 'context' || line.type === 'addition') newLineNum++;
	}

	if (currentHunk !== null) {
		hunks.push(currentHunk);
	}

	return hunks;
}

/**
 * Formats hunks into a unified diff string. `oldPath` defaults to `filePath`
 * and only needs to differ from it to represent a rename.
 */
export function formatUnifiedDiff(
	filePath: string,
	oldText: string,
	newText: string,
	contextLines: number = 3,
	oldPath: string = filePath
): { unified: string; additions: number; deletions: number } {
	const isNew = oldText.length === 0 && newText.length > 0;
	const isDeleted = oldText.length > 0 && newText.length === 0;

	const { lines, additions, deletions } = computeLineDiff(oldText, newText);
	if (additions === 0 && deletions === 0) {
		return { unified: '', additions: 0, deletions: 0 };
	}

	const hunks = buildUnifiedHunks(lines, contextLines);
	if (hunks.length === 0) {
		return { unified: '', additions: 0, deletions: 0 };
	}

	const oldHeader = isNew ? '/dev/null' : `a/${oldPath}`;
	const newHeader = isDeleted ? '/dev/null' : `b/${filePath}`;
	const oldLineCount = textLines(oldText).length;
	const newLineCount = textLines(newText).length;
	const oldNoFinalNewline = oldText.length > 0 && !oldText.endsWith('\n');
	const newNoFinalNewline = newText.length > 0 && !newText.endsWith('\n');

	const output: string[] = [`--- ${oldHeader}`, `+++ ${newHeader}`];

	for (const hunk of hunks) {
		const oldStart = hunk.oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart;
		const newStart = hunk.newCount === 0 ? hunk.newStart - 1 : hunk.newStart;
		const oldRange = hunk.oldCount === 1 ? `${oldStart}` : `${oldStart},${hunk.oldCount}`;
		const newRange = hunk.newCount === 1 ? `${newStart}` : `${newStart},${hunk.newCount}`;
		output.push(`@@ -${oldRange} +${newRange} @@`);
		let oldLineNumber = hunk.oldStart;
		let newLineNumber = hunk.newStart;
		for (const line of hunk.lines) {
			const prefix = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
			output.push(`${prefix}${line.text}`);
			const oldLast = line.type !== 'addition' && oldLineNumber === oldLineCount;
			const newLast = line.type !== 'deletion' && newLineNumber === newLineCount;
			if ((oldLast && oldNoFinalNewline) || (newLast && newNoFinalNewline)) {
				output.push('\\ No newline at end of file');
			}
			if (line.type !== 'addition') oldLineNumber++;
			if (line.type !== 'deletion') newLineNumber++;
		}
	}

	return { unified: output.join('\n') + '\n', additions, deletions };
}

function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character. `String.slice` counts UTF-16 code units, not bytes,
 * so a byte-count used as a slice index can both overshoot the budget (for
 * non-ASCII content) and cut a multi-byte sequence in half.
 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	const encoded = new TextEncoder().encode(text);
	if (encoded.byteLength <= maxBytes) return text;
	const decoder = new TextDecoder('utf-8', { fatal: true });
	// A UTF-8 code point occupies at most four bytes, so at most four
	// attempts are needed to find the last complete character.
	for (let end = maxBytes; end > Math.max(0, maxBytes - 4); end--) {
		try {
			return decoder.decode(encoded.subarray(0, end));
		} catch {
			// The cut is inside a multi-byte sequence; try the preceding byte.
		}
	}
	return '';
}

/**
 * Generates a structured diff between two revision document sets and contents.
 */
export function generateRevisionDiff(input: {
	base: {
		generation: number;
		commitSha: string | null;
		manifest: DocumentSetManifest | null;
		documents: ReadonlyMap<string, string>;
	};
	head: {
		generation: number;
		commitSha: string | null;
		message?: string | null;
		manifest: DocumentSetManifest | null;
		documents: ReadonlyMap<string, string>;
	};
	options?: GenerateDiffOptions;
}): RevisionDiffResult {
	const maxDiffBytes = Math.max(
		0,
		Math.min(input.options?.maxDiffBytes ?? MAX_DIFF_BYTES, MAX_DIFF_BYTES)
	);
	const maxFiles = Math.max(0, Math.min(input.options?.maxFiles ?? MAX_DIFF_FILES, MAX_DIFF_FILES));
	const includeUnified = input.options?.includeUnified ?? true;
	const contextLines = input.options?.contextLines ?? 3;

	const baseLeaves = input.base.manifest?.documents ?? [];
	const headLeaves = input.head.manifest?.documents ?? [];

	const baseById = new Map<string, DocumentSetLeaf>();
	for (const leaf of baseLeaves) {
		baseById.set(leaf.id, leaf);
	}

	interface DeferredMarkdownDiff {
		change: DocumentChange;
		path: string;
		oldPath: string;
		baseContent: string;
		headContent: string;
	}

	const processedBaseIds = new Set<string>();
	const allChanges: DocumentChange[] = [];
	// Line-level Markdown diffing (the only expensive step) is deferred until
	// after the maxFiles cut below, so files beyond the limit never pay for it.
	const deferredDiffs: DeferredMarkdownDiff[] = [];

	let documentsAdded = 0;
	let documentsRemoved = 0;
	let documentsModified = 0;
	let documentsReordered = 0;
	let titlesChangedCount = 0;

	// Process head documents in order
	for (const headLeaf of headLeaves) {
		const baseLeaf = baseById.get(headLeaf.id);

		if (!baseLeaf) {
			// Document Added
			documentsAdded++;
			let pdfDetails: DocumentPdfDetailsDiff | undefined;

			const change: DocumentChange = {
				documentId: headLeaf.id,
				kind: headLeaf.kind,
				path: headLeaf.kind === 'markdown' ? headLeaf.path : undefined,
				pathChanged: false,
				changeType: 'added',
				addition: true,
				removal: false,
				titleChanged: false,
				orderChanged: false,
				contentChanged: true,
				title: { current: headLeaf.title, changed: false },
				position: { current: headLeaf.position, changed: false },
				content:
					headLeaf.kind === 'markdown'
						? { changed: true, currentSha256: headLeaf.contentSha256, additions: 0, deletions: 0 }
						: { changed: true, currentSha256: headLeaf.sha256, additions: 0, deletions: 0 },
				pdf: undefined
			};

			if (headLeaf.kind === 'markdown') {
				const headContent = input.head.documents.get(headLeaf.path) ?? '';
				deferredDiffs.push({
					change,
					path: headLeaf.path,
					oldPath: headLeaf.path,
					baseContent: '',
					headContent
				});
			} else {
				pdfDetails = {
					currentByteSize: headLeaf.byteSize,
					currentPageCount: headLeaf.pageCount,
					currentPageWidth: headLeaf.pageWidth,
					currentPageHeight: headLeaf.pageHeight
				};
				change.pdf = pdfDetails;
			}

			allChanges.push(change);
		} else {
			// Existed in base
			processedBaseIds.add(baseLeaf.id);

			const titleChanged = baseLeaf.title !== headLeaf.title;
			const orderChanged = baseLeaf.position !== headLeaf.position;
			const pathChanged =
				headLeaf.kind === 'markdown' &&
				baseLeaf.kind === 'markdown' &&
				baseLeaf.path !== headLeaf.path;
			let contentChanged: boolean;
			let pdfDetails: DocumentPdfDetailsDiff | undefined;

			if (titleChanged) titlesChangedCount++;
			if (orderChanged) documentsReordered++;

			let content: DocumentContentDiff;

			if (headLeaf.kind === 'markdown' && baseLeaf.kind === 'markdown') {
				const baseContent = input.base.documents.get(baseLeaf.path) ?? '';
				const headContent = input.head.documents.get(headLeaf.path) ?? '';
				contentChanged =
					baseLeaf.contentSha256 !== headLeaf.contentSha256 || baseContent !== headContent;

				content = contentChanged
					? {
							changed: true,
							previousSha256: baseLeaf.contentSha256,
							currentSha256: headLeaf.contentSha256,
							additions: 0,
							deletions: 0
						}
					: {
							changed: false,
							previousSha256: baseLeaf.contentSha256,
							currentSha256: headLeaf.contentSha256,
							additions: 0,
							deletions: 0
						};
			} else if (headLeaf.kind === 'pdf' && baseLeaf.kind === 'pdf') {
				contentChanged = baseLeaf.sha256 !== headLeaf.sha256;

				content = {
					changed: contentChanged,
					previousSha256: baseLeaf.sha256,
					currentSha256: headLeaf.sha256,
					additions: 0,
					deletions: 0
				};
				pdfDetails = {
					previousByteSize: baseLeaf.byteSize,
					currentByteSize: headLeaf.byteSize,
					previousPageCount: baseLeaf.pageCount,
					currentPageCount: headLeaf.pageCount,
					previousPageWidth: baseLeaf.pageWidth,
					currentPageWidth: headLeaf.pageWidth,
					previousPageHeight: baseLeaf.pageHeight,
					currentPageHeight: headLeaf.pageHeight
				};
			} else {
				// Type changed between markdown and pdf
				contentChanged = true;
				content = { changed: true, additions: 0, deletions: 0 };
			}

			const isUnchanged = !contentChanged && !titleChanged && !orderChanged && !pathChanged;
			const changeType: DocumentChangeType = isUnchanged ? 'unchanged' : 'modified';
			if (!isUnchanged) documentsModified++;

			const change: DocumentChange = {
				documentId: headLeaf.id,
				kind: headLeaf.kind,
				path: headLeaf.kind === 'markdown' ? headLeaf.path : undefined,
				previousPath: pathChanged && baseLeaf.kind === 'markdown' ? baseLeaf.path : undefined,
				pathChanged,
				changeType,
				addition: false,
				removal: false,
				titleChanged,
				orderChanged,
				contentChanged,
				title: {
					current: headLeaf.title,
					previous: baseLeaf.title,
					changed: titleChanged
				},
				position: {
					current: headLeaf.position,
					previous: baseLeaf.position,
					changed: orderChanged
				},
				content,
				pdf: pdfDetails
			};

			if (contentChanged && headLeaf.kind === 'markdown' && baseLeaf.kind === 'markdown') {
				const baseContent = input.base.documents.get(baseLeaf.path) ?? '';
				const headContent = input.head.documents.get(headLeaf.path) ?? '';
				deferredDiffs.push({
					change,
					path: headLeaf.path,
					oldPath: pathChanged ? baseLeaf.path : headLeaf.path,
					baseContent,
					headContent
				});
			}

			allChanges.push(change);
		}
	}

	// Process removed base documents
	for (const baseLeaf of baseLeaves) {
		if (processedBaseIds.has(baseLeaf.id)) continue;

		documentsRemoved++;
		let pdfDetails: DocumentPdfDetailsDiff | undefined;

		const change: DocumentChange = {
			documentId: baseLeaf.id,
			kind: baseLeaf.kind,
			path: baseLeaf.kind === 'markdown' ? baseLeaf.path : undefined,
			pathChanged: false,
			changeType: 'removed',
			addition: false,
			removal: true,
			titleChanged: false,
			orderChanged: false,
			contentChanged: true,
			title: {
				current: baseLeaf.title,
				previous: baseLeaf.title,
				changed: false
			},
			position: {
				previous: baseLeaf.position,
				changed: false
			},
			content:
				baseLeaf.kind === 'markdown'
					? { changed: true, previousSha256: baseLeaf.contentSha256, additions: 0, deletions: 0 }
					: { changed: true, previousSha256: baseLeaf.sha256, additions: 0, deletions: 0 },
			pdf: undefined
		};

		if (baseLeaf.kind === 'markdown') {
			const baseContent = input.base.documents.get(baseLeaf.path) ?? '';
			deferredDiffs.push({
				change,
				path: baseLeaf.path,
				oldPath: baseLeaf.path,
				baseContent,
				headContent: ''
			});
		} else {
			pdfDetails = {
				previousByteSize: baseLeaf.byteSize,
				previousPageCount: baseLeaf.pageCount,
				previousPageWidth: baseLeaf.pageWidth,
				previousPageHeight: baseLeaf.pageHeight
			};
			change.pdf = pdfDetails;
		}

		allChanges.push(change);
	}

	// Apply the file-count bound before doing any expensive line-level
	// diffing: only files that survive this cut are ever diffed below.
	let truncated = false;
	let truncationReason: 'diff_bytes_limit' | 'file_count_limit' | undefined;
	let returnedChanges: DocumentChange[] = allChanges;

	if (allChanges.length > maxFiles) {
		truncated = true;
		truncationReason = 'file_count_limit';
		// Unchanged leaves are useful context, but must never consume the
		// response budget ahead of an actual addition, removal, or edit.
		returnedChanges = [
			...allChanges.filter((change) => change.changeType !== 'unchanged'),
			...allChanges.filter((change) => change.changeType === 'unchanged')
		].slice(0, maxFiles);
	}

	const returnedSet = new Set(returnedChanges);
	let remainingStructuredDiffBytes = maxDiffBytes;
	for (const deferred of deferredDiffs) {
		if (!returnedSet.has(deferred.change)) continue;
		if (!includeUnified || remainingStructuredDiffBytes === 0) {
			const counts = computeLineDiff(deferred.baseContent, deferred.headContent);
			deferred.change.content.additions = counts.additions;
			deferred.change.content.deletions = counts.deletions;
			if (includeUnified) {
				deferred.change.content.truncated = true;
				truncated = true;
				truncationReason = 'diff_bytes_limit';
			}
			continue;
		}
		const diff = formatUnifiedDiff(
			deferred.path,
			deferred.baseContent,
			deferred.headContent,
			contextLines,
			deferred.oldPath
		);
		if (diff.unified.length > 0) {
			const diffBytes = utf8ByteLength(diff.unified);
			if (diffBytes <= remainingStructuredDiffBytes) {
				deferred.change.content.unifiedDiff = diff.unified;
				remainingStructuredDiffBytes -= diffBytes;
			} else {
				const marker = truncateToUtf8Bytes(TRUNCATION_MARKER, remainingStructuredDiffBytes);
				const contentBudget = remainingStructuredDiffBytes - utf8ByteLength(marker);
				deferred.change.content.unifiedDiff =
					truncateToUtf8Bytes(diff.unified, contentBudget) + marker;
				deferred.change.content.truncated = true;
				truncated = true;
				truncationReason = 'diff_bytes_limit';
				remainingStructuredDiffBytes = 0;
			}
		}
		deferred.change.content.additions = diff.additions;
		deferred.change.content.deletions = diff.deletions;
	}

	// Build unified diff text for all changes
	const unifiedTextParts: string[] = [];
	let totalUnifiedBytes = 0;

	for (const change of returnedChanges) {
		if (change.changeType === 'unchanged') continue;

		let fileHeader: string;
		if (change.kind === 'markdown' && change.path) {
			const fromPath = change.previousPath ?? change.path;
			fileHeader = `diff --git a/${fromPath} b/${change.path}\n`;
			if (change.addition) {
				fileHeader += `new file mode 100644\n`;
			} else if (change.removal) {
				fileHeader += `deleted file mode 100644\n`;
			} else if (change.pathChanged) {
				fileHeader += `rename from ${fromPath}\nrename to ${change.path}\n`;
				if (!change.contentChanged) {
					fileHeader += `similarity index 100%\n`;
				}
			}
		} else {
			const leafPath = `documents/document-${change.documentId}.pdf`;
			fileHeader = `diff --git a/${leafPath} b/${leafPath}\n`;
			if (change.addition) {
				fileHeader += `new binary file (PDF: "${change.title.current}")\n`;
			} else if (change.removal) {
				fileHeader += `deleted binary file (PDF: "${change.title.previous ?? change.title.current}")\n`;
			} else if (change.contentChanged) {
				fileHeader += `Binary files differ (PDF: sha256 changed from ${change.content.previousSha256} to ${change.content.currentSha256})\n`;
			}
		}

		if (change.titleChanged) {
			fileHeader += `# Title changed: "${change.title.previous}" -> "${change.title.current}"\n`;
		}
		if (change.orderChanged) {
			fileHeader += `# Order changed: position ${change.position.previous} -> ${change.position.current}\n`;
		}

		let part = fileHeader;
		if (change.kind === 'markdown' && change.content.unifiedDiff) {
			part += change.content.unifiedDiff;
		}

		const partBytes = utf8ByteLength(part);
		const separatorBytes = unifiedTextParts.length > 0 ? 1 : 0;
		const availableBytes = Math.max(0, maxDiffBytes - totalUnifiedBytes - separatorBytes);
		if (partBytes > availableBytes) {
			truncated = true;
			truncationReason = 'diff_bytes_limit';
			if (availableBytes === 0) break;
			const markerBytes = utf8ByteLength(TRUNCATION_MARKER);
			const budgetForPart = Math.max(0, availableBytes - markerBytes);
			if (budgetForPart > 0) {
				const truncatedPart = truncateToUtf8Bytes(part, budgetForPart);
				const finalPiece = truncatedPart + TRUNCATION_MARKER;
				unifiedTextParts.push(finalPiece);
			} else {
				const markerOnly = truncateToUtf8Bytes(TRUNCATION_MARKER, availableBytes);
				unifiedTextParts.push(markerOnly);
			}
			break;
		} else {
			unifiedTextParts.push(part);
			totalUnifiedBytes += separatorBytes + partBytes;
		}
	}

	const totalChanges = documentsAdded + documentsRemoved + documentsModified;

	return {
		schema: REVISION_DIFF_SCHEMA,
		base: {
			generation: input.base.generation,
			commitSha: input.base.commitSha
		},
		head: {
			generation: input.head.generation,
			commitSha: input.head.commitSha,
			message: input.head.message ?? null
		},
		summary: {
			documentsAdded,
			documentsRemoved,
			documentsModified,
			documentsReordered,
			titlesChanged: titlesChangedCount,
			totalChanges
		},
		changes: returnedChanges,
		unifiedText: unifiedTextParts.join('\n'),
		truncated,
		truncationReason
	};
}
