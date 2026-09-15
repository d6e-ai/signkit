import git from 'isomorphic-git';
import { gzipSync } from 'fflate';
import { normalizeMarkdownContent } from '$lib/domain/draft';
import {
	assertDraftTrackedPath,
	DOCUMENT_SET_MANIFEST_PATH,
	isDocumentSetManifestPath
} from '$lib/domain/document-set';
import { isMarkdownPath } from '$lib/domain/envelope';
import type {
	DraftActor,
	DraftCommitOptions,
	DraftDocument,
	DraftEdit,
	DraftRepository,
	DraftVersion
} from '$lib/ports/draft-repository';
import { MemoryFs, type ArchivedFile } from './memory-fs';

const FORMAT = 'signkit-git-archive-v1';
const DIRECTORY = '/repository';
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_DECODED_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5_000;

interface ArchivePayload {
	format: typeof FORMAT;
	files: ArchivedFile[];
}

export class IsomorphicGitDraftRepository implements DraftRepository {
	async read(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<readonly DraftDocument[]> {
		if (archive === null) {
			if (expectedCommitSha !== null) throw new Error('Empty draft has an unexpected Git head');
			return [];
		}
		if (expectedCommitSha === null) throw new Error('Persisted draft is missing its Git head');
		const fs: MemoryFs = await restore(archive);
		const client = fs.asClient();
		const actualCommitSha: string = await git.resolveRef({
			fs: client,
			dir: DIRECTORY,
			ref: 'HEAD'
		});
		if (actualCommitSha !== expectedCommitSha) {
			throw new Error('Draft repository HEAD does not match its database pointer');
		}
		const status = await git.statusMatrix({ fs: client, dir: DIRECTORY });
		if (status.some(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1)) {
			throw new Error('Draft repository contains uncommitted content');
		}
		const paths: string[] = await git.listFiles({ fs: client, dir: DIRECTORY });
		const documents: DraftDocument[] = [];
		for (const path of paths.sort()) {
			assertDraftTrackedPath(path);
			if (isDocumentSetManifestPath(path)) continue;
			if (!isMarkdownPath(path)) {
				throw new Error('Draft repository contains an unrecognized path');
			}
			const content: Uint8Array | string = await fs.promises.readFile(
				`${DIRECTORY}/${path}`,
				'utf8'
			);
			if (typeof content !== 'string') throw new Error('Draft document was not decoded as text');
			documents.push({ path, content });
		}
		return documents;
	}

	async readManifest(
		archive: Uint8Array | null,
		expectedCommitSha: string | null
	): Promise<string | null> {
		if (archive === null) {
			if (expectedCommitSha !== null) throw new Error('Empty draft has an unexpected Git head');
			return null;
		}
		if (expectedCommitSha === null) throw new Error('Persisted draft is missing its Git head');
		const fs: MemoryFs = await restore(archive);
		const client = fs.asClient();
		const actualCommitSha: string = await git.resolveRef({
			fs: client,
			dir: DIRECTORY,
			ref: 'HEAD'
		});
		if (actualCommitSha !== expectedCommitSha) {
			throw new Error('Draft repository HEAD does not match its database pointer');
		}
		const paths: string[] = await git.listFiles({ fs: client, dir: DIRECTORY });
		if (!paths.includes(DOCUMENT_SET_MANIFEST_PATH)) return null;
		const content: Uint8Array | string = await fs.promises.readFile(
			`${DIRECTORY}/${DOCUMENT_SET_MANIFEST_PATH}`,
			'utf8'
		);
		if (typeof content !== 'string') throw new Error('Document set was not decoded as text');
		return content;
	}

	async commit(
		archive: Uint8Array | null,
		edits: readonly DraftEdit[],
		message: string,
		actor: DraftActor,
		options?: DraftCommitOptions
	): Promise<DraftVersion> {
		if (edits.length === 0) throw new Error('At least one draft edit is required');
		const fs = await restore(archive);
		const client = fs.asClient();

		if (archive === null) await git.init({ fs: client, dir: DIRECTORY, defaultBranch: 'main' });
		if (options?.replaceTrackedPaths === true && archive !== null) {
			const keep: Set<string> = new Set(edits.map((edit: DraftEdit): string => edit.path));
			const tracked: string[] = await git.listFiles({ fs: client, dir: DIRECTORY });
			for (const path of tracked) {
				if (keep.has(path)) continue;
				await git.remove({ fs: client, dir: DIRECTORY, filepath: path });
				// git.remove() only unstages the file; it leaves it on disk, which would
				// otherwise show up as untracked and make read() see uncommitted content.
				await fs.promises.unlink(`${DIRECTORY}/${path}`);
			}
		}
		for (const edit of edits) {
			assertDraftTrackedPath(edit.path);
			const content: string = isMarkdownPath(edit.path)
				? normalizeMarkdownContent(edit.content)
				: edit.content;
			await fs.promises.writeFile(`${DIRECTORY}/${edit.path}`, content);
			await git.add({ fs: client, dir: DIRECTORY, filepath: edit.path });
		}

		const commitSha = await git.commit({
			fs: client,
			dir: DIRECTORY,
			message: `${message.trim()}\n\nActor-Type: ${actor.type}\nActor-ID: ${actor.id}`,
			author: { name: actor.name, email: actor.email }
		});
		const nextPaths: string[] = (await git.listFiles({ fs: client, dir: DIRECTORY }))
			.slice()
			.sort();
		const nextArchive = encodeArchive(fs.exportFiles());
		return {
			commitSha,
			archive: nextArchive,
			archiveSha256: await sha256(nextArchive),
			paths: nextPaths
		};
	}
}

async function restore(archive: Uint8Array | null): Promise<MemoryFs> {
	const fs = new MemoryFs();
	if (archive === null) return fs;
	if (archive.byteLength > MAX_ARCHIVE_BYTES)
		throw new Error('Draft repository archive exceeds the size limit');
	const decodedBytes: Uint8Array = await gunzipBounded(archive);
	const decoded = JSON.parse(new TextDecoder().decode(decodedBytes)) as Partial<ArchivePayload>;
	if (decoded.format !== FORMAT || !Array.isArray(decoded.files))
		throw new Error('Unsupported draft repository archive');
	if (decoded.files.length > MAX_FILES)
		throw new Error('Draft repository archive contains too many files');
	for (const file of decoded.files) {
		if (!file.path.startsWith(`${DIRECTORY}/`) || file.path.includes('..'))
			throw new Error('Unsafe path in draft repository archive');
	}
	await fs.importFiles(decoded.files);
	return fs;
}

function encodeArchive(files: ArchivedFile[]): Uint8Array {
	const payload: ArchivePayload = { format: FORMAT, files };
	const decoded: Uint8Array = new TextEncoder().encode(JSON.stringify(payload));
	if (decoded.byteLength > MAX_DECODED_ARCHIVE_BYTES) {
		throw new Error('Draft repository archive exceeds the decoded size limit');
	}
	return gzipSync(decoded, { level: 9, mtime: 0 });
}

const GZIP_SLICE_BYTES = 64 * 1024;

function readableByteSlices(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let offset: number = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const end: number = Math.min(offset + GZIP_SLICE_BYTES, bytes.byteLength);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		}
	});
}

async function gunzipBounded(archive: Uint8Array): Promise<Uint8Array> {
	if (archive.byteLength < 4) throw new Error('Invalid draft repository archive');
	const footerOffset: number = archive.byteLength - 4;
	const decodedSize: number =
		archive[footerOffset] |
		(archive[footerOffset + 1] << 8) |
		(archive[footerOffset + 2] << 16) |
		(archive[footerOffset + 3] << 24);
	const unsignedDecodedSize: number = decodedSize >>> 0;
	if (unsignedDecodedSize > MAX_DECODED_ARCHIVE_BYTES) {
		throw new Error('Draft repository archive exceeds the decoded size limit');
	}

	let decompressed: ReadableStream<Uint8Array>;
	try {
		decompressed = readableByteSlices(archive).pipeThrough(
			new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>
		);
	} catch {
		throw new Error('Invalid draft repository archive');
	}

	const reader = decompressed.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > MAX_DECODED_ARCHIVE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// Ignore cancel error.
				}
				throw new Error('Draft repository archive exceeds the decoded size limit');
			}
			chunks.push(result.value);
		}
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			error.message === 'Draft repository archive exceeds the decoded size limit'
		) {
			throw error;
		}
		throw new Error('Invalid draft repository archive', { cause: error });
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore release lock error.
		}
	}

	const decoded = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		decoded.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decoded;
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
