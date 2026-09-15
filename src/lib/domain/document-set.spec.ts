import { describe, expect, it } from 'vitest';
import type { MarkdownPath } from '$lib/domain/envelope';
import {
	DOCUMENT_SET_DOMAIN,
	DOCUMENT_SET_MANIFEST_PATH,
	DOCUMENT_SET_SCHEMA,
	appendPdfDocument,
	canonicalLeafJson,
	documentSetHash,
	documentSetInclusionProof,
	hashDocumentSetLeaf,
	isDocumentSetManifestPath,
	parseDocumentSet,
	reorderDocumentSet,
	serializeDocumentSet,
	upsertMarkdownDocument,
	verifyDocumentSetInclusionProof,
	type DocumentSetLeaf,
	type DocumentSetManifest,
	type MarkdownDocumentLeaf,
	type PdfDocumentLeaf
} from './document-set';

const ID_A: string = '01900000-0000-7000-8000-0000000000a1';
const ID_B: string = '01900000-0000-7000-8000-0000000000a2';
const ID_C: string = '01900000-0000-7000-8000-0000000000a3';
const SHA_A: string = 'a'.repeat(64);
const SHA_B: string = 'b'.repeat(64);
const SHA_C: string = 'c'.repeat(64);
const SHA_D: string = 'd'.repeat(64);

function markdownLeaf(
	id: string,
	position: number,
	path: MarkdownPath,
	contentSha256: string = SHA_A
): MarkdownDocumentLeaf {
	return {
		id,
		position,
		kind: 'markdown',
		title: path.replace(/^documents\//, '').replace(/\.md$/, ''),
		path,
		contentSha256
	};
}

function pdfLeaf(id: string, position: number, sha256: string = SHA_B): PdfDocumentLeaf {
	return {
		id,
		position,
		kind: 'pdf',
		title: 'Schedule A',
		sha256,
		byteSize: 812345,
		pageCount: 12,
		pageWidth: 595.28,
		pageHeight: 841.89
	};
}

function manifestOf(documents: readonly DocumentSetLeaf[]): DocumentSetManifest {
	return { schema: DOCUMENT_SET_SCHEMA, documents };
}

async function sha256Parts(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
	let size: number = 0;
	for (const part of parts) size += part.byteLength;
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return new Uint8Array(digest);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte: number): string => byte.toString(16).padStart(2, '0')).join('');
}

function rfc6962Leaf(data: Uint8Array): Promise<Uint8Array> {
	return sha256Parts(Uint8Array.of(0x00), data);
}

async function domainLeaf(leaf: DocumentSetLeaf): Promise<Uint8Array> {
	const domain: Uint8Array = new TextEncoder().encode(DOCUMENT_SET_DOMAIN);
	const payload: Uint8Array = new TextEncoder().encode(canonicalLeafJson(leaf));
	return sha256Parts(Uint8Array.of(0x00), domain, payload);
}

async function domainNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
	const domain: Uint8Array = new TextEncoder().encode(DOCUMENT_SET_DOMAIN);
	return sha256Parts(Uint8Array.of(0x01), domain, left, right);
}

function largestPowerOfTwoLessThan(n: number): number {
	let k: number = 1;
	while (k * 2 < n) k *= 2;
	return k;
}

async function expectedRoot(leaves: readonly DocumentSetLeaf[]): Promise<string> {
	const hashed: Uint8Array[] = [];
	for (const leaf of leaves) hashed.push(await domainLeaf(leaf));
	return hex(await expectedMerkle(hashed));
}

async function expectedMerkle(leaves: readonly Uint8Array[]): Promise<Uint8Array> {
	if (leaves.length === 1) return leaves[0];
	const k: number = largestPowerOfTwoLessThan(leaves.length);
	return domainNode(
		await expectedMerkle(leaves.slice(0, k)),
		await expectedMerkle(leaves.slice(k))
	);
}

describe('document-set.json', () => {
	it('round-trips a mixed canonical manifest', () => {
		const manifest: DocumentSetManifest = manifestOf([
			markdownLeaf(ID_A, 0, 'documents/nda.md', SHA_A),
			pdfLeaf(ID_B, 1)
		]);
		const serialized: string = serializeDocumentSet(manifest);
		expect(serialized.endsWith('\n')).toBe(true);
		expect(serialized).toContain('"schema":"signkit-document-set-v1"');
		expect(parseDocumentSet(serialized)).toEqual(manifest);
	});

	it('rejects unknown keys and reordered keys', () => {
		const valid: string = serializeDocumentSet(
			manifestOf([markdownLeaf(ID_A, 0, 'documents/nda.md')])
		);
		expect(() => parseDocumentSet(valid.replace('"schema"', '"schema","extra":1,"x"'))).toThrow(
			/canonical|valid JSON|invalid/
		);
		expect(() =>
			parseDocumentSet(
				`{"documents":[${canonicalLeafJson(markdownLeaf(ID_A, 0, 'documents/nda.md'))}],"schema":"${DOCUMENT_SET_SCHEMA}"}\n`
			)
		).toThrow(/canonical/);
	});

	it('treats document-set.json as the only non-markdown tracked path', () => {
		expect(isDocumentSetManifestPath(DOCUMENT_SET_MANIFEST_PATH)).toBe(true);
		expect(isDocumentSetManifestPath('documents/nda.md')).toBe(false);
	});
});

describe('documentSetHash RFC 6962', () => {
	const leavesBySize: ReadonlyMap<number, DocumentSetLeaf[]> = new Map([
		[1, [markdownLeaf(ID_A, 0, 'documents/a.md', SHA_A)]],
		[2, [markdownLeaf(ID_A, 0, 'documents/a.md', SHA_A), pdfLeaf(ID_B, 1, SHA_B)]],
		[
			3,
			[
				markdownLeaf(ID_A, 0, 'documents/a.md', SHA_A),
				pdfLeaf(ID_B, 1, SHA_B),
				markdownLeaf(ID_C, 2, 'documents/c.md', SHA_C)
			]
		]
	]);

	it.each([1, 2, 3, 4, 5, 8])(
		'matches a hand-assembled Merkle root for n = %s',
		async (n: number) => {
			const leaves: DocumentSetLeaf[] = Array.from({ length: n }, (_, index: number) => {
				const id: string = `01900000-0000-7000-8000-${(0xa00000000000 + index).toString(16)}`;
				if (index % 2 === 1) {
					return pdfLeaf(id, index, index % 4 === 1 ? SHA_B : SHA_D);
				}
				return markdownLeaf(id, index, `documents/doc-${index}.md`, index === 0 ? SHA_A : SHA_C);
			});
			expect(await documentSetHash(manifestOf(leaves))).toBe(await expectedRoot(leaves));
		}
	);

	it('changes when two leaves swap order', async () => {
		const original: DocumentSetManifest = manifestOf(leavesBySize.get(2) ?? []);
		const swapped: DocumentSetManifest = manifestOf([
			{ ...original.documents[1], position: 0 },
			{ ...original.documents[0], position: 1 }
		] as DocumentSetLeaf[]);
		expect(await documentSetHash(original)).not.toBe(await documentSetHash(swapped));
	});

	it('domain-separates a leaf from RFC 6962 without DOMAIN', async () => {
		const leaf: DocumentSetLeaf = markdownLeaf(ID_A, 0, 'documents/nda.md');
		const withDomain: Uint8Array = await hashDocumentSetLeaf(leaf);
		const rfc: Uint8Array = await rfc6962Leaf(new TextEncoder().encode(canonicalLeafJson(leaf)));
		expect(hex(withDomain)).not.toBe(hex(rfc));
	});
});

describe('documentSetInclusionProof', () => {
	it('verifies every index and fails a mutated leaf, a wrong index, and a truncated path', async () => {
		const documents: DocumentSetLeaf[] = [
			markdownLeaf(ID_A, 0, 'documents/a.md', SHA_A),
			pdfLeaf(ID_B, 1, SHA_B),
			markdownLeaf(ID_C, 2, 'documents/c.md', SHA_C)
		];
		const manifest: DocumentSetManifest = manifestOf(documents);
		for (let index = 0; index < documents.length; index += 1) {
			const proof = await documentSetInclusionProof(manifest, index);
			expect(await verifyDocumentSetInclusionProof(manifest, proof)).toBe(true);
			const [first, second, third] = documents;
			if (first === undefined || second === undefined || third === undefined) {
				throw new Error('expected a three-document set');
			}
			if (first.kind !== 'markdown') {
				throw new Error('expected a markdown leaf at index 0');
			}
			const mutatedLeaf = await documentSetInclusionProof(
				manifestOf([{ ...first, contentSha256: SHA_D }, second, third]),
				index
			);
			expect(await verifyDocumentSetInclusionProof(manifest, mutatedLeaf)).toBe(false);
			expect(
				await verifyDocumentSetInclusionProof(manifest, { ...proof, index: (index + 1) % 3 })
			).toBe(false);
			expect(
				await verifyDocumentSetInclusionProof(manifest, {
					...proof,
					siblings: proof.siblings.slice(0, Math.max(0, proof.siblings.length - 1))
				})
			).toBe(false);
		}
	});
});

describe('document set mutations', () => {
	it('appends a PDF leaf to a Markdown-only set', () => {
		const start: DocumentSetManifest = upsertMarkdownDocument(
			null,
			'documents/nda.md',
			SHA_A,
			(): string => ID_A
		);
		const mixed: DocumentSetManifest = appendPdfDocument(
			start,
			{
				title: 'Schedule A',
				sha256: SHA_B,
				byteSize: 812345,
				pageCount: 12,
				pageWidth: 595.28,
				pageHeight: 841.89
			},
			(): string => ID_B
		);
		expect(mixed.documents.map((leaf) => leaf.kind)).toEqual(['markdown', 'pdf']);
		expect(mixed.documents[1]?.id).toBe(ID_B);
	});

	it('reorders and removes by the full id list', () => {
		const start: DocumentSetManifest = appendPdfDocument(
			upsertMarkdownDocument(null, 'documents/nda.md', SHA_A, (): string => ID_A),
			{
				title: 'Schedule A',
				sha256: SHA_B,
				byteSize: 812345,
				pageCount: 12,
				pageWidth: 595.28,
				pageHeight: 841.89
			},
			(): string => ID_B
		);
		const reordered: DocumentSetManifest = reorderDocumentSet(start, [ID_B, ID_A]);
		expect(reordered.documents.map((leaf) => leaf.id)).toEqual([ID_B, ID_A]);
		expect(reordered.documents[0]?.position).toBe(0);
		const removed: DocumentSetManifest = reorderDocumentSet(start, [ID_A]);
		expect(removed.documents).toHaveLength(1);
		expect(removed.documents[0]?.id).toBe(ID_A);
	});
});
