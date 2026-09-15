import { isMarkdownPath, type MarkdownPath } from '$lib/domain/envelope';
import { isUuidV7 } from '$lib/ids/uuid-v7';

export const DOCUMENT_SET_SCHEMA: string = 'signkit-document-set-v1';
export const DOCUMENT_SET_DOMAIN: string = 'signkit:document-set:v1';
export const DOCUMENT_SET_MANIFEST_PATH = 'document-set.json' as const;
export const MAX_DOCUMENT_SET_SIZE: number = 20;
export const MAX_DOCUMENT_TITLE_LENGTH: number = 200;
/** Matches the uploaded-PDF byte cap; pdf leaves cannot claim a larger object. */
export const MAX_DOCUMENT_PDF_BYTES: number = 20 * 1024 * 1024;
export const MAX_DOCUMENT_PDF_PAGES: number = 400;
export const MAX_DOCUMENT_PDF_PAGE_DIMENSION: number = 20_000;

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const LEAF_PREFIX: number = 0x00;
const NODE_PREFIX: number = 0x01;

export type DocumentSetManifestPath = typeof DOCUMENT_SET_MANIFEST_PATH;
export type DraftTrackedPath = MarkdownPath | DocumentSetManifestPath;
export type DocumentKind = 'markdown' | 'pdf';

export interface MarkdownDocumentLeaf {
	id: string;
	position: number;
	kind: 'markdown';
	title: string;
	path: MarkdownPath;
	contentSha256: string;
}

export interface PdfDocumentLeaf {
	id: string;
	position: number;
	kind: 'pdf';
	title: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
}

export type DocumentSetLeaf = MarkdownDocumentLeaf | PdfDocumentLeaf;

export interface DocumentSetManifest {
	schema: typeof DOCUMENT_SET_SCHEMA;
	documents: readonly DocumentSetLeaf[];
}

export interface DocumentSetInclusionProof {
	index: number;
	size: number;
	leafHash: string;
	siblings: readonly string[];
}

export class DocumentSetError extends Error {
	readonly code = 'DOCUMENT_SET_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'DocumentSetError';
	}
}

export function isDocumentSetManifestPath(path: string): path is DocumentSetManifestPath {
	return path === DOCUMENT_SET_MANIFEST_PATH;
}

export function isDraftTrackedPath(path: string): path is DraftTrackedPath {
	return isMarkdownPath(path) || isDocumentSetManifestPath(path);
}

export function assertDraftTrackedPath(path: string): asserts path is DraftTrackedPath {
	if (!isDraftTrackedPath(path)) {
		throw new DocumentSetError(
			'Draft repositories accept Markdown files under documents/ and document-set.json only'
		);
	}
}

export function markdownDocumentTitle(path: MarkdownPath): string {
	const name: string = path
		.replace(/^documents\//, '')
		.replace(/\.md$/, '')
		.replaceAll(/[-_]+/g, ' ')
		.trim();
	return name.length > 0 ? name : path;
}

export function canonicalLeafJson(leaf: DocumentSetLeaf): string {
	assertLeaf(leaf);
	if (leaf.kind === 'markdown') {
		return JSON.stringify({
			id: leaf.id,
			position: leaf.position,
			kind: 'markdown',
			title: leaf.title,
			path: leaf.path,
			contentSha256: leaf.contentSha256
		});
	}
	return JSON.stringify({
		id: leaf.id,
		position: leaf.position,
		kind: 'pdf',
		title: leaf.title,
		sha256: leaf.sha256,
		byteSize: leaf.byteSize,
		pageCount: leaf.pageCount,
		pageWidth: leaf.pageWidth,
		pageHeight: leaf.pageHeight
	});
}

export function serializeDocumentSet(manifest: DocumentSetManifest): string {
	assertDocumentSet(manifest);
	const leaves: string = manifest.documents
		.map((leaf: DocumentSetLeaf): string => ` ${canonicalLeafJson(leaf)}`)
		.join(',\n');
	return `{"schema":"${DOCUMENT_SET_SCHEMA}","documents":[\n${leaves}\n]}\n`;
}

export function parseDocumentSet(content: string): DocumentSetManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		throw new DocumentSetError('Document set is not valid JSON');
	}
	const manifest: DocumentSetManifest = parseDocumentSetValue(parsed);
	if (serializeDocumentSet(manifest) !== content) {
		throw new DocumentSetError('Document set is not canonical');
	}
	return manifest;
}

export async function hashDocumentSetLeaf(leaf: DocumentSetLeaf): Promise<Uint8Array> {
	const domain: Uint8Array = new TextEncoder().encode(DOCUMENT_SET_DOMAIN);
	const payload: Uint8Array = new TextEncoder().encode(canonicalLeafJson(leaf));
	return sha256Parts(Uint8Array.of(LEAF_PREFIX), domain, payload);
}

export async function documentSetHash(manifest: DocumentSetManifest): Promise<string> {
	assertDocumentSet(manifest);
	const leaves: Uint8Array[] = [];
	for (const leaf of manifest.documents) {
		leaves.push(await hashDocumentSetLeaf(leaf));
	}
	return bytesToHex(await merkleRoot(leaves));
}

export async function documentSetInclusionProof(
	manifest: DocumentSetManifest,
	index: number
): Promise<DocumentSetInclusionProof> {
	assertDocumentSet(manifest);
	if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.documents.length) {
		throw new DocumentSetError('Document set inclusion index is out of range');
	}
	const leaves: Uint8Array[] = [];
	for (const leaf of manifest.documents) {
		leaves.push(await hashDocumentSetLeaf(leaf));
	}
	return {
		index,
		size: leaves.length,
		leafHash: bytesToHex(leaves[index]),
		siblings: (await inclusionSiblings(leaves, index)).map(bytesToHex)
	};
}

export async function verifyDocumentSetInclusionProof(
	manifest: DocumentSetManifest,
	proof: DocumentSetInclusionProof
): Promise<boolean> {
	assertDocumentSet(manifest);
	if (proof.size !== manifest.documents.length) return false;
	if (!Number.isSafeInteger(proof.index) || proof.index < 0 || proof.index >= proof.size) {
		return false;
	}
	if (!SHA256_PATTERN.test(proof.leafHash)) return false;
	const expectedLeaf: string = bytesToHex(
		await hashDocumentSetLeaf(manifest.documents[proof.index])
	);
	if (expectedLeaf !== proof.leafHash) return false;
	const siblings: Uint8Array[] = [];
	for (const hash of proof.siblings) {
		if (!SHA256_PATTERN.test(hash)) return false;
		siblings.push(hexToBytes(hash));
	}
	try {
		const root: Uint8Array = await foldInclusionProof(
			hexToBytes(proof.leafHash),
			proof.index,
			proof.size,
			siblings
		);
		return bytesToHex(root) === (await documentSetHash(manifest));
	} catch (error: unknown) {
		if (error instanceof DocumentSetError) return false;
		throw error;
	}
}

export function upsertMarkdownDocument(
	manifest: DocumentSetManifest | null,
	path: MarkdownPath,
	contentSha256: string,
	mintId: () => string,
	title?: string
): DocumentSetManifest {
	if (!isMarkdownPath(path)) throw new DocumentSetError('Markdown document path is invalid');
	if (!SHA256_PATTERN.test(contentSha256)) {
		throw new DocumentSetError('Markdown content digest is invalid');
	}
	const documents: DocumentSetLeaf[] = manifest === null ? [] : [...manifest.documents];
	const existingIndex: number = documents.findIndex(
		(leaf: DocumentSetLeaf): boolean => leaf.kind === 'markdown' && leaf.path === path
	);
	const leafTitle: string = title ?? markdownDocumentTitle(path);
	if (existingIndex >= 0) {
		const current: DocumentSetLeaf = documents[existingIndex];
		if (current.kind !== 'markdown') {
			throw new DocumentSetError('Document id is already used by a PDF');
		}
		documents[existingIndex] = {
			...current,
			title: leafTitle,
			contentSha256
		};
		return renumber({ schema: DOCUMENT_SET_SCHEMA, documents });
	}
	documents.push({
		id: mintId(),
		position: documents.length,
		kind: 'markdown',
		title: leafTitle,
		path,
		contentSha256
	});
	return renumber({ schema: DOCUMENT_SET_SCHEMA, documents });
}

export function appendPdfDocument(
	manifest: DocumentSetManifest | null,
	input: {
		id?: string;
		title: string;
		sha256: string;
		byteSize: number;
		pageCount: number;
		pageWidth: number;
		pageHeight: number;
		position?: number;
	},
	mintId: () => string
): DocumentSetManifest {
	const documents: DocumentSetLeaf[] = manifest === null ? [] : [...manifest.documents];
	const position: number = input.position ?? documents.length;
	if (!Number.isSafeInteger(position) || position < 0 || position > documents.length) {
		throw new DocumentSetError('PDF document position is out of range');
	}
	const leaf: PdfDocumentLeaf = {
		id: input.id ?? mintId(),
		position,
		kind: 'pdf',
		title: input.title,
		sha256: input.sha256,
		byteSize: input.byteSize,
		pageCount: input.pageCount,
		pageWidth: input.pageWidth,
		pageHeight: input.pageHeight
	};
	assertLeaf(leaf);
	documents.splice(position, 0, leaf);
	return renumber({ schema: DOCUMENT_SET_SCHEMA, documents });
}

export function reorderDocumentSet(
	manifest: DocumentSetManifest,
	documentIds: readonly string[]
): DocumentSetManifest {
	assertDocumentSet(manifest);
	if (documentIds.length < 1) {
		throw new DocumentSetError('A document set must contain at least one document');
	}
	const byId: Map<string, DocumentSetLeaf> = new Map(
		manifest.documents.map((leaf: DocumentSetLeaf): [string, DocumentSetLeaf] => [leaf.id, leaf])
	);
	if (documentIds.length > byId.size) {
		throw new DocumentSetError('Document order repeats or names an unknown document');
	}
	const seen: Set<string> = new Set<string>();
	const documents: DocumentSetLeaf[] = [];
	for (const id of documentIds) {
		if (seen.has(id)) throw new DocumentSetError('Document order repeats a document id');
		const leaf: DocumentSetLeaf | undefined = byId.get(id);
		if (leaf === undefined) {
			throw new DocumentSetError('Document order names an unknown document');
		}
		seen.add(id);
		documents.push(leaf);
	}
	if (documents.length < 1) {
		throw new DocumentSetError('A document set must contain at least one document');
	}
	return renumber({ schema: DOCUMENT_SET_SCHEMA, documents });
}

export function materializeMarkdownLeaves(
	paths: readonly MarkdownPath[],
	contentSha256ByPath: ReadonlyMap<string, string>,
	mintId: () => string
): DocumentSetManifest {
	const sorted: MarkdownPath[] = [...paths].sort();
	const documents: DocumentSetLeaf[] = sorted.map(
		(path: MarkdownPath, position: number): MarkdownDocumentLeaf => {
			const contentSha256: string | undefined = contentSha256ByPath.get(path);
			if (contentSha256 === undefined || !SHA256_PATTERN.test(contentSha256)) {
				throw new DocumentSetError('Markdown content digest is missing');
			}
			return {
				id: mintId(),
				position,
				kind: 'markdown',
				title: markdownDocumentTitle(path),
				path,
				contentSha256
			};
		}
	);
	return renumber({ schema: DOCUMENT_SET_SCHEMA, documents });
}

function parseDocumentSetValue(value: unknown): DocumentSetManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new DocumentSetError('Document set is invalid');
	}
	const candidate = value as Record<string, unknown>;
	const keys: string[] = Object.keys(candidate);
	if (keys.length !== 2 || keys[0] !== 'schema' || keys[1] !== 'documents') {
		throw new DocumentSetError('Document set is not canonical');
	}
	if (candidate.schema !== DOCUMENT_SET_SCHEMA) {
		throw new DocumentSetError('Document set schema is unsupported');
	}
	if (!Array.isArray(candidate.documents)) {
		throw new DocumentSetError('Document set is invalid');
	}
	const documents: DocumentSetLeaf[] = candidate.documents.map(
		(entry: unknown, index: number): DocumentSetLeaf => parseLeaf(entry, index)
	);
	const manifest: DocumentSetManifest = { schema: DOCUMENT_SET_SCHEMA, documents };
	assertDocumentSet(manifest);
	return manifest;
}

function parseLeaf(value: unknown, index: number): DocumentSetLeaf {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new DocumentSetError('Document set leaf is invalid');
	}
	const candidate = value as Record<string, unknown>;
	const keys: string[] = Object.keys(candidate);
	if (candidate.kind === 'markdown') {
		if (
			keys.length !== 6 ||
			keys[0] !== 'id' ||
			keys[1] !== 'position' ||
			keys[2] !== 'kind' ||
			keys[3] !== 'title' ||
			keys[4] !== 'path' ||
			keys[5] !== 'contentSha256'
		) {
			throw new DocumentSetError('Document set leaf is not canonical');
		}
		if (typeof candidate.path !== 'string' || !isMarkdownPath(candidate.path)) {
			throw new DocumentSetError('Markdown document path is invalid');
		}
		if (typeof candidate.contentSha256 !== 'string') {
			throw new DocumentSetError('Markdown content digest is invalid');
		}
		const leaf: MarkdownDocumentLeaf = {
			id: asUuid(candidate.id),
			position: asPosition(candidate.position, index),
			kind: 'markdown',
			title: asTitle(candidate.title),
			path: candidate.path,
			contentSha256: asSha256(candidate.contentSha256, 'Markdown content digest is invalid')
		};
		assertLeaf(leaf);
		return leaf;
	}
	if (candidate.kind === 'pdf') {
		if (
			keys.length !== 9 ||
			keys[0] !== 'id' ||
			keys[1] !== 'position' ||
			keys[2] !== 'kind' ||
			keys[3] !== 'title' ||
			keys[4] !== 'sha256' ||
			keys[5] !== 'byteSize' ||
			keys[6] !== 'pageCount' ||
			keys[7] !== 'pageWidth' ||
			keys[8] !== 'pageHeight'
		) {
			throw new DocumentSetError('Document set leaf is not canonical');
		}
		const leaf: PdfDocumentLeaf = {
			id: asUuid(candidate.id),
			position: asPosition(candidate.position, index),
			kind: 'pdf',
			title: asTitle(candidate.title),
			sha256: asSha256(candidate.sha256, 'Uploaded PDF digest is invalid'),
			byteSize: asByteSize(candidate.byteSize),
			pageCount: asPageCount(candidate.pageCount),
			pageWidth: asPageDimension(candidate.pageWidth),
			pageHeight: asPageDimension(candidate.pageHeight)
		};
		assertLeaf(leaf);
		return leaf;
	}
	throw new DocumentSetError('Document set leaf kind is invalid');
}

function assertDocumentSet(manifest: DocumentSetManifest): void {
	if (manifest.schema !== DOCUMENT_SET_SCHEMA) {
		throw new DocumentSetError('Document set schema is unsupported');
	}
	if (manifest.documents.length < 1 || manifest.documents.length > MAX_DOCUMENT_SET_SIZE) {
		throw new DocumentSetError(
			`A document set must contain between 1 and ${MAX_DOCUMENT_SET_SIZE} documents`
		);
	}
	const ids: Set<string> = new Set<string>();
	const markdownPaths: Set<string> = new Set<string>();
	for (let index = 0; index < manifest.documents.length; index += 1) {
		const leaf: DocumentSetLeaf = manifest.documents[index];
		assertLeaf(leaf);
		if (leaf.position !== index) {
			throw new DocumentSetError('Document set positions must be contiguous and match array order');
		}
		if (ids.has(leaf.id)) throw new DocumentSetError('Document set ids must be unique');
		ids.add(leaf.id);
		if (leaf.kind === 'markdown') {
			if (markdownPaths.has(leaf.path)) {
				throw new DocumentSetError('Markdown document paths must be unique');
			}
			markdownPaths.add(leaf.path);
		}
	}
}

function assertLeaf(leaf: DocumentSetLeaf): void {
	if (!isUuidV7(leaf.id)) throw new DocumentSetError('Document id is not a UUIDv7');
	if (
		!Number.isSafeInteger(leaf.position) ||
		leaf.position < 0 ||
		leaf.position >= MAX_DOCUMENT_SET_SIZE
	) {
		throw new DocumentSetError('Document position is invalid');
	}
	if (!isTitle(leaf.title)) throw new DocumentSetError('Document title is invalid');
	if (leaf.kind === 'markdown') {
		if (!isMarkdownPath(leaf.path)) throw new DocumentSetError('Markdown document path is invalid');
		if (!SHA256_PATTERN.test(leaf.contentSha256)) {
			throw new DocumentSetError('Markdown content digest is invalid');
		}
		return;
	}
	if (!SHA256_PATTERN.test(leaf.sha256)) {
		throw new DocumentSetError('Uploaded PDF digest is invalid');
	}
	if (
		!Number.isSafeInteger(leaf.byteSize) ||
		leaf.byteSize <= 0 ||
		leaf.byteSize > MAX_DOCUMENT_PDF_BYTES
	) {
		throw new DocumentSetError('Uploaded PDF size is invalid');
	}
	if (
		!Number.isSafeInteger(leaf.pageCount) ||
		leaf.pageCount < 1 ||
		leaf.pageCount > MAX_DOCUMENT_PDF_PAGES
	) {
		throw new DocumentSetError('Uploaded PDF page count is invalid');
	}
	if (!isPageDimension(leaf.pageWidth) || !isPageDimension(leaf.pageHeight)) {
		throw new DocumentSetError('Uploaded PDF page size is invalid');
	}
}

function renumber(manifest: DocumentSetManifest): DocumentSetManifest {
	const documents: DocumentSetLeaf[] = manifest.documents.map(
		(leaf: DocumentSetLeaf, position: number): DocumentSetLeaf => ({ ...leaf, position })
	);
	const next: DocumentSetManifest = { schema: DOCUMENT_SET_SCHEMA, documents };
	assertDocumentSet(next);
	return next;
}

function asUuid(value: unknown): string {
	if (typeof value !== 'string' || !isUuidV7(value)) {
		throw new DocumentSetError('Document id is not a UUIDv7');
	}
	return value;
}

function asPosition(value: unknown, index: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value !== index) {
		throw new DocumentSetError('Document set positions must be contiguous and match array order');
	}
	return value;
}

function asTitle(value: unknown): string {
	if (typeof value !== 'string' || !isTitle(value)) {
		throw new DocumentSetError('Document title is invalid');
	}
	return value;
}

function asSha256(value: unknown, message: string): string {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
		throw new DocumentSetError(message);
	}
	return value;
}

function asByteSize(value: unknown): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > MAX_DOCUMENT_PDF_BYTES
	) {
		throw new DocumentSetError('Uploaded PDF size is invalid');
	}
	return value;
}

function asPageCount(value: unknown): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_DOCUMENT_PDF_PAGES
	) {
		throw new DocumentSetError('Uploaded PDF page count is invalid');
	}
	return value;
}

function asPageDimension(value: unknown): number {
	if (!isPageDimension(value)) throw new DocumentSetError('Uploaded PDF page size is invalid');
	return value;
}

function isTitle(value: string): boolean {
	if (value.length < 1 || value.length > MAX_DOCUMENT_TITLE_LENGTH) return false;
	for (let index = 0; index < value.length; index += 1) {
		const code: number = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return false;
	}
	return true;
}

function isPageDimension(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value > 0 &&
		value <= MAX_DOCUMENT_PDF_PAGE_DIMENSION
	);
}

async function merkleRoot(leaves: readonly Uint8Array[]): Promise<Uint8Array> {
	if (leaves.length === 0)
		throw new DocumentSetError('A document set must contain at least one document');
	if (leaves.length === 1) return leaves[0];
	const k: number = largestPowerOfTwoLessThan(leaves.length);
	return hashNode(await merkleRoot(leaves.slice(0, k)), await merkleRoot(leaves.slice(k)));
}

async function inclusionSiblings(
	leaves: readonly Uint8Array[],
	index: number
): Promise<Uint8Array[]> {
	if (leaves.length === 1) return [];
	const k: number = largestPowerOfTwoLessThan(leaves.length);
	if (index < k) {
		return [
			...(await inclusionSiblings(leaves.slice(0, k), index)),
			await merkleRoot(leaves.slice(k))
		];
	}
	return [
		...(await inclusionSiblings(leaves.slice(k), index - k)),
		await merkleRoot(leaves.slice(0, k))
	];
}

async function foldInclusionProof(
	leafHash: Uint8Array,
	index: number,
	size: number,
	siblings: readonly Uint8Array[]
): Promise<Uint8Array> {
	if (size === 1) {
		if (siblings.length !== 0) return Uint8Array.of();
		return leafHash;
	}
	if (siblings.length < 1) {
		throw new DocumentSetError('Document set inclusion proof is truncated');
	}
	const k: number = largestPowerOfTwoLessThan(size);
	const sibling: Uint8Array | undefined = siblings[siblings.length - 1];
	if (sibling === undefined) {
		throw new DocumentSetError('Document set inclusion proof is truncated');
	}
	const rest: Uint8Array[] = siblings.slice(0, -1);
	if (index < k) {
		const left: Uint8Array = await foldInclusionProof(leafHash, index, k, rest);
		if (left.byteLength === 0) return left;
		return hashNode(left, sibling);
	}
	const right: Uint8Array = await foldInclusionProof(leafHash, index - k, size - k, rest);
	if (right.byteLength === 0) return right;
	return hashNode(sibling, right);
}

async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
	const domain: Uint8Array = new TextEncoder().encode(DOCUMENT_SET_DOMAIN);
	return sha256Parts(Uint8Array.of(NODE_PREFIX), domain, left, right);
}

function largestPowerOfTwoLessThan(n: number): number {
	let k: number = 1;
	while (k * 2 < n) k *= 2;
	return k;
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

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte: number): string => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
	const bytes: Uint8Array = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.byteLength; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
