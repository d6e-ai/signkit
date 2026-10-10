import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentSetManifest } from './document-set';
import {
	computeLineDiff,
	formatUnifiedDiff,
	generateRevisionDiff,
	REVISION_DIFF_SCHEMA
} from './revision-diff';

describe('revision-diff domain', () => {
	describe('computeLineDiff and formatUnifiedDiff', () => {
		it('computes empty diff for identical content', () => {
			const text = 'line 1\nline 2\nline 3';
			const result = formatUnifiedDiff('documents/test.md', text, text);
			expect(result.unified).toBe('');
			expect(result.additions).toBe(0);
			expect(result.deletions).toBe(0);
		});

		it('formats additions for newly added file', () => {
			const newText = 'line 1\nline 2';
			const result = formatUnifiedDiff('documents/test.md', '', newText);
			expect(result.unified).toContain('--- /dev/null');
			expect(result.unified).toContain('+++ b/documents/test.md');
			expect(result.unified).toContain('+line 1');
			expect(result.unified).toContain('+line 2');
			expect(result.additions).toBe(2);
			expect(result.deletions).toBe(0);
		});

		it('formats deletions for deleted file', () => {
			const oldText = 'line 1\nline 2';
			const result = formatUnifiedDiff('documents/test.md', oldText, '');
			expect(result.unified).toContain('--- a/documents/test.md');
			expect(result.unified).toContain('+++ /dev/null');
			expect(result.unified).toContain('-line 1');
			expect(result.unified).toContain('-line 2');
			expect(result.additions).toBe(0);
			expect(result.deletions).toBe(2);
		});

		it('formats modifications with context lines', () => {
			const oldText = 'prefix 1\nprefix 2\nprefix 3\nold middle\nsuffix 1\nsuffix 2\nsuffix 3';
			const newText = 'prefix 1\nprefix 2\nprefix 3\nnew middle\nsuffix 1\nsuffix 2\nsuffix 3';
			const result = formatUnifiedDiff('documents/test.md', oldText, newText);
			expect(result.unified).toContain('-old middle');
			expect(result.unified).toContain('+new middle');
			expect(result.unified).toContain(' prefix 3');
			expect(result.unified).toContain(' suffix 1');
			expect(result.additions).toBe(1);
			expect(result.deletions).toBe(1);
		});

		it('does not count the trailing newline as a phantom line in a patch', () => {
			const result = formatUnifiedDiff('documents/test.md', 'old\n', 'new\n');
			expect(result.additions).toBe(1);
			expect(result.deletions).toBe(1);
			expect(result.unified).toContain('@@ -1 +1 @@\n-old\n+new\n');
			const added = formatUnifiedDiff('documents/test.md', '', 'new\n');
			expect(added.additions).toBe(1);
			expect(added.unified).toContain('@@ -0,0 +1 @@');
		});

		it('produces an EOF patch accepted by git apply', () => {
			const directory = mkdtempSync(join(tmpdir(), 'signkit-revision-diff-'));
			try {
				execFileSync('git', ['init', '-q'], { cwd: directory });
				mkdirSync(join(directory, 'documents'));
				writeFileSync(join(directory, 'documents', 'test.md'), 'old\n');
				const diff = formatUnifiedDiff('documents/test.md', 'old\n', 'new\n');
				expect(() =>
					execFileSync('git', ['apply', '--check', '-'], { cwd: directory, input: diff.unified })
				).not.toThrow();
				const deleted = formatUnifiedDiff('documents/test.md', 'old\n', '');
				expect(() =>
					execFileSync('git', ['apply', '--check', '-'], { cwd: directory, input: deleted.unified })
				).not.toThrow();
				const added = formatUnifiedDiff('documents/new.md', '', 'new\n');
				expect(() =>
					execFileSync('git', ['apply', '--check', '-'], { cwd: directory, input: added.unified })
				).not.toThrow();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});

		it('marks changed final lines that lack a trailing newline', () => {
			const result = formatUnifiedDiff('documents/test.md', 'old', 'new');
			expect(result.unified).toContain(
				'-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file'
			);
		});
	});

	describe('generateRevisionDiff', () => {
		const baseManifest: DocumentSetManifest = {
			schema: 'signkit-document-set-v1',
			documents: [
				{
					id: '01900000-0000-7000-8000-000000000001',
					position: 0,
					kind: 'markdown',
					title: 'NDA Agreement',
					path: 'documents/nda.md',
					contentSha256: 'a'.repeat(64)
				},
				{
					id: '01900000-0000-7000-8000-000000000002',
					position: 1,
					kind: 'pdf',
					title: 'Exhibit A',
					sha256: 'b'.repeat(64),
					byteSize: 1024,
					pageCount: 1,
					pageWidth: 595,
					pageHeight: 842
				}
			]
		};

		it('identifies unchanged document set', () => {
			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', '# NDA\nInitial content']])
				},
				head: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', '# NDA\nInitial content']])
				}
			});

			expect(diff.schema).toBe(REVISION_DIFF_SCHEMA);
			expect(diff.summary.totalChanges).toBe(0);
			expect(diff.changes.every((c) => c.changeType === 'unchanged')).toBe(true);
			expect(diff.unifiedText).toBe('');
		});

		it('identifies multi-document edits, additions, and removals', () => {
			const headManifest: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					// Exhibit A reordered to position 0, title changed
					{
						id: '01900000-0000-7000-8000-000000000002',
						position: 0,
						kind: 'pdf',
						title: 'Exhibit A - Specifications',
						sha256: 'b'.repeat(64),
						byteSize: 1024,
						pageCount: 1,
						pageWidth: 595,
						pageHeight: 842
					},
					// NDA edited and moved to position 1
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 1,
						kind: 'markdown',
						title: 'NDA Agreement',
						path: 'documents/nda.md',
						contentSha256: 'c'.repeat(64)
					},
					// New PDF added
					{
						id: '01900000-0000-7000-8000-000000000003',
						position: 2,
						kind: 'pdf',
						title: 'Exhibit B',
						sha256: 'd'.repeat(64),
						byteSize: 2048,
						pageCount: 2,
						pageWidth: 595,
						pageHeight: 842
					}
				]
			};

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', '# NDA\nInitial content']])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					message: 'Reorder and add exhibit',
					manifest: headManifest,
					documents: new Map([['documents/nda.md', '# NDA\nUpdated content with new clause']])
				}
			});

			expect(diff.summary.documentsAdded).toBe(1);
			expect(diff.summary.documentsRemoved).toBe(0);
			expect(diff.summary.documentsModified).toBe(2);
			expect(diff.summary.documentsReordered).toBe(2);
			expect(diff.summary.titlesChanged).toBe(1);

			// Exhibit A
			const exhibitA = diff.changes.find(
				(c) => c.documentId === '01900000-0000-7000-8000-000000000002'
			)!;
			expect(exhibitA.titleChanged).toBe(true);
			expect(exhibitA.orderChanged).toBe(true);
			expect(exhibitA.title.previous).toBe('Exhibit A');
			expect(exhibitA.title.current).toBe('Exhibit A - Specifications');
			expect(exhibitA.position.previous).toBe(1);
			expect(exhibitA.position.current).toBe(0);

			// NDA
			const nda = diff.changes.find(
				(c) => c.documentId === '01900000-0000-7000-8000-000000000001'
			)!;
			expect(nda.contentChanged).toBe(true);
			expect(nda.orderChanged).toBe(true);
			expect(nda.content.unifiedDiff).toContain('-Initial content');
			expect(nda.content.unifiedDiff).toContain('+Updated content with new clause');

			// Exhibit B (added)
			const exhibitB = diff.changes.find(
				(c) => c.documentId === '01900000-0000-7000-8000-000000000003'
			)!;
			expect(exhibitB.addition).toBe(true);
			expect(exhibitB.changeType).toBe('added');
			expect(exhibitB.pdf?.currentPageCount).toBe(2);
		});

		it('bounds diff size and reports truncation explicitly', () => {
			const bigContent = 'x'.repeat(2000);
			const headManifest: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'NDA Agreement',
						path: 'documents/nda.md',
						contentSha256: 'c'.repeat(64)
					}
				]
			};

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', 'short']])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: headManifest,
					documents: new Map([['documents/nda.md', bigContent]])
				},
				options: {
					maxDiffBytes: 100
				}
			});

			expect(diff.truncated).toBe(true);
			expect(diff.truncationReason).toBe('diff_bytes_limit');
			expect(diff.unifiedText).toContain('[diff truncated: exceeded byte limit]');
			const markdownChange = diff.changes.find((change) => change.path === 'documents/nda.md');
			expect(markdownChange?.content.truncated).toBe(true);
			expect(
				new TextEncoder().encode(markdownChange?.content.unifiedDiff ?? '').byteLength
			).toBeLessThanOrEqual(100);
		});

		it('truncates unified diff text at a UTF-8 byte boundary without exceeding the budget or emitting a replacement character', () => {
			const headManifest: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'NDA Agreement',
						path: 'documents/nda.md',
						contentSha256: 'c'.repeat(64)
					}
				]
			};
			// Each character is 3 bytes in UTF-8, so a character-index slice
			// using a byte-count budget would both overshoot the byte limit
			// and cut a character in half.
			const multiByteContent = '日本語'.repeat(100);

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', 'short']])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: headManifest,
					documents: new Map([['documents/nda.md', multiByteContent]])
				},
				// Large enough to land the cut inside the multi-byte diff body
				// (well past the ASCII diff/hunk headers), so the truncation
				// must actually navigate a 3-byte character boundary.
				options: { maxDiffBytes: 150 }
			});

			expect(diff.truncated).toBe(true);
			expect(diff.truncationReason).toBe('diff_bytes_limit');
			const byteLength = new TextEncoder().encode(diff.unifiedText).byteLength;
			expect(byteLength).toBeLessThanOrEqual(150);
			expect(diff.unifiedText).not.toContain('�');
			const markdownChange = diff.changes.find((change) => change.path === 'documents/nda.md');
			expect(markdownChange?.content.truncated).toBe(true);
			expect(
				new TextEncoder().encode(markdownChange?.content.unifiedDiff ?? '').byteLength
			).toBeLessThanOrEqual(150);
			expect(markdownChange?.content.unifiedDiff).not.toContain('�');
		});

		it('applies maxFiles before computing expensive line diffs, returning only the bounded files with full diff detail', () => {
			const baseThree: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'Doc 1',
						path: 'documents/doc1.md',
						contentSha256: 'a'.repeat(64)
					},
					{
						id: '01900000-0000-7000-8000-000000000002',
						position: 1,
						kind: 'markdown',
						title: 'Doc 2',
						path: 'documents/doc2.md',
						contentSha256: 'b'.repeat(64)
					},
					{
						id: '01900000-0000-7000-8000-000000000003',
						position: 2,
						kind: 'markdown',
						title: 'Doc 3',
						path: 'documents/doc3.md',
						contentSha256: 'c'.repeat(64)
					}
				]
			};
			const headThree: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'Doc 1',
						path: 'documents/doc1.md',
						contentSha256: 'a2'.padEnd(64, '0')
					},
					{
						id: '01900000-0000-7000-8000-000000000002',
						position: 1,
						kind: 'markdown',
						title: 'Doc 2',
						path: 'documents/doc2.md',
						contentSha256: 'b2'.padEnd(64, '0')
					},
					{
						id: '01900000-0000-7000-8000-000000000003',
						position: 2,
						kind: 'markdown',
						title: 'Doc 3',
						path: 'documents/doc3.md',
						contentSha256: 'c2'.padEnd(64, '0')
					}
				]
			};

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseThree,
					documents: new Map([
						['documents/doc1.md', 'one old'],
						['documents/doc2.md', 'two old'],
						['documents/doc3.md', 'three old']
					])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: headThree,
					documents: new Map([
						['documents/doc1.md', 'one new'],
						['documents/doc2.md', 'two new'],
						['documents/doc3.md', 'three new']
					])
				},
				options: { maxFiles: 1 }
			});

			expect(diff.truncated).toBe(true);
			expect(diff.truncationReason).toBe('file_count_limit');
			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0].path).toBe('documents/doc1.md');
			expect(diff.changes[0].content.unifiedDiff).toContain('-one old');
			expect(diff.changes[0].content.unifiedDiff).toContain('+one new');
			// The summary reflects all three changed documents even though the
			// returned, diffed change list is bounded by maxFiles.
			expect(diff.summary.documentsModified).toBe(3);
		});

		it('does not let unchanged documents hide a removal at the file-count limit', () => {
			const base: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [1, 2, 3].map((number) => ({
					id: `01900000-0000-7000-8000-00000000000${number}`,
					position: number - 1,
					kind: 'markdown' as const,
					title: `Doc ${number}`,
					path: `documents/doc${number}.md` as `documents/${string}.md`,
					contentSha256: String(number).repeat(64)
				}))
			};
			const head: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: base.documents.slice(0, 2)
			};
			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: base,
					documents: new Map([
						['documents/doc1.md', 'one'],
						['documents/doc2.md', 'two'],
						['documents/doc3.md', 'three']
					])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: head,
					documents: new Map([
						['documents/doc1.md', 'one'],
						['documents/doc2.md', 'two']
					])
				},
				options: { maxFiles: 1 }
			});
			expect(diff.summary.documentsRemoved).toBe(1);
			expect(diff.changes).toHaveLength(1);
			expect(diff.changes[0].changeType).toBe('removed');
			expect(diff.unifiedText).toContain('documents/doc3.md');
		});

		it('computes totalChanges as the count of changed documents, not a mix of per-document and boolean flags', () => {
			const twoDocBase: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'Doc A',
						path: 'documents/a.md',
						contentSha256: 'a'.repeat(64)
					},
					{
						id: '01900000-0000-7000-8000-000000000002',
						position: 1,
						kind: 'markdown',
						title: 'Doc B',
						path: 'documents/b.md',
						contentSha256: 'b'.repeat(64)
					}
				]
			};
			const twoDocHead: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{ ...twoDocBase.documents[0], position: 1 },
					{ ...twoDocBase.documents[1], position: 0 }
				]
			};

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: twoDocBase,
					documents: new Map([
						['documents/a.md', 'A'],
						['documents/b.md', 'B']
					])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: twoDocHead,
					documents: new Map([
						['documents/a.md', 'A'],
						['documents/b.md', 'B']
					])
				}
			});

			expect(diff.summary.documentsAdded).toBe(0);
			expect(diff.summary.documentsRemoved).toBe(0);
			expect(diff.summary.documentsModified).toBe(2);
			expect(diff.summary.documentsReordered).toBe(2);
			expect(diff.summary.titlesChanged).toBe(0);
			// Two documents actually changed (both reordered, nothing else).
			// A formula that adds +1 whenever any doc is reordered on top of
			// documentsModified would wrongly report 3 here.
			expect(diff.summary.totalChanges).toBe(2);
		});

		it('represents a Markdown path rename even when content, title, and position are unchanged', () => {
			const headManifest: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'NDA Agreement',
						path: 'documents/nda-v2.md',
						contentSha256: 'a'.repeat(64)
					},
					baseManifest.documents[1]
				]
			};

			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: baseManifest,
					documents: new Map([['documents/nda.md', '# NDA\nInitial content']])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: headManifest,
					documents: new Map([['documents/nda-v2.md', '# NDA\nInitial content']])
				}
			});

			const renamed = diff.changes.find(
				(c) => c.documentId === '01900000-0000-7000-8000-000000000001'
			)!;
			// A pure rename must not disappear as "unchanged" — the caller
			// would otherwise never learn the document moved.
			expect(renamed.changeType).toBe('modified');
			expect(renamed.pathChanged).toBe(true);
			expect(renamed.previousPath).toBe('documents/nda.md');
			expect(renamed.path).toBe('documents/nda-v2.md');
			expect(renamed.contentChanged).toBe(false);
			expect(diff.unifiedText).toContain('rename from documents/nda.md');
			expect(diff.unifiedText).toContain('rename to documents/nda-v2.md');
		});

		it('keeps deletion visible when a renamed document takes the deleted path', () => {
			const base: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'A',
						path: 'documents/a.md',
						contentSha256: 'a'.repeat(64)
					},
					{
						id: '01900000-0000-7000-8000-000000000002',
						position: 1,
						kind: 'markdown',
						title: 'B',
						path: 'documents/b.md',
						contentSha256: 'b'.repeat(64)
					}
				]
			};
			const head: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'A',
						path: 'documents/b.md',
						contentSha256: 'a'.repeat(64)
					}
				]
			};
			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: base,
					documents: new Map([
						['documents/a.md', 'A'],
						['documents/b.md', 'B']
					])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: head,
					documents: new Map([['documents/b.md', 'A']])
				}
			});
			expect(diff.summary.documentsRemoved).toBe(1);
			expect(diff.summary.documentsModified).toBe(1);
			expect(diff.changes.find((change) => change.documentId.endsWith('0002'))?.removal).toBe(true);
		});

		it('counts a new document at a renamed document’s old path as an addition', () => {
			const base: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'A',
						path: 'documents/a.md',
						contentSha256: 'a'.repeat(64)
					}
				]
			};
			const head: DocumentSetManifest = {
				schema: 'signkit-document-set-v1',
				documents: [
					{
						id: '01900000-0000-7000-8000-000000000001',
						position: 0,
						kind: 'markdown',
						title: 'A',
						path: 'documents/b.md',
						contentSha256: 'a'.repeat(64)
					},
					{
						id: '01900000-0000-7000-8000-000000000003',
						position: 1,
						kind: 'markdown',
						title: 'C',
						path: 'documents/a.md',
						contentSha256: 'c'.repeat(64)
					}
				]
			};
			const diff = generateRevisionDiff({
				base: {
					generation: 1,
					commitSha: '1'.repeat(40),
					manifest: base,
					documents: new Map([['documents/a.md', 'A']])
				},
				head: {
					generation: 2,
					commitSha: '2'.repeat(40),
					manifest: head,
					documents: new Map([
						['documents/b.md', 'A'],
						['documents/a.md', 'C']
					])
				}
			});
			expect(diff.summary.documentsAdded).toBe(1);
			expect(diff.summary.documentsModified).toBe(1);
			expect(diff.changes.find((change) => change.documentId.endsWith('0003'))?.addition).toBe(
				true
			);
		});
	});

	describe('computeLineDiff work bound', () => {
		it('falls back to a deterministic whole-file replacement above the LCS matrix cell cap', () => {
			// 2100 x 2100 lines exceeds the 4,000,000-cell LCS cap, forcing the
			// deterministic fallback (all-old-deleted, all-new-added) instead of
			// an unbounded dynamic-programming matrix that would otherwise
			// allocate tens of megabytes and run in worst-case quadratic time.
			const oldLines = Array.from({ length: 2100 }, (_, i) => `old-${i}`);
			const newLines = Array.from({ length: 2100 }, (_, i) => `new-${i}`);

			const result = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));

			expect(result.additions).toBe(2100);
			expect(result.deletions).toBe(2100);
			expect(result.lines).toHaveLength(4200);
			expect(result.lines.slice(0, 2100).every((line) => line.type === 'deletion')).toBe(true);
			expect(result.lines.slice(2100).every((line) => line.type === 'addition')).toBe(true);
		});
	});
});
