import { join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser, x as tarExtract } from 'tar';
import { MAX_EXTRACT_ENTRIES, MAX_EXTRACT_UNCOMPRESSED_BYTES } from '../constants.js';
import { generic } from '../cli/errors.js';
import type { FileSystem } from '../runtime/fs.js';
import type { ReleaseManifest } from './manifest.js';

export interface ExtractedBundle {
	root: string;
	main: string;
	assetsDirectory: string;
	migrationsDirectory: string;
	configPath: string;
}

export interface BundleExtractor {
	extract(
		archive: Uint8Array,
		destDir: string,
		manifest: ReleaseManifest
	): Promise<ExtractedBundle>;
}

export interface ExtractLimits {
	maxUncompressedBytes?: number;
	maxEntries?: number;
}

const ALLOWED_TAR_TYPES = new Set(['File', 'OldFile', 'Directory', 'ContiguousFile']);
const REGULAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

export function createTarGzExtractor(fs: FileSystem): BundleExtractor {
	return {
		async extract(archive, destDir, manifest) {
			await fs.mkdir(destDir);
			await extractTarGz(archive, destDir);
			return locateBundle(fs, destDir, manifest);
		}
	};
}

export function isAllowedTarEntryType(type: string): boolean {
	return ALLOWED_TAR_TYPES.has(type);
}

export function isRegularTarFileType(type: string): boolean {
	return REGULAR_FILE_TYPES.has(type);
}

export async function extractTarGz(
	archive: Uint8Array,
	destDir: string,
	limits: ExtractLimits = {}
): Promise<void> {
	const root = resolve(destDir);
	const budget = createTarBudget(limits);
	await assertSafeTarContents(archive, root, budget);
	const extractBudget = createTarBudget(limits);
	await pipeline(
		Readable.from([Buffer.from(archive)]),
		tarExtract({
			cwd: destDir,
			gzip: true,
			strict: true,
			preservePaths: false,
			filter(entryPath, entry) {
				accountTarMember(String(entryPath), entry, root, extractBudget);
				return true;
			}
		})
	);
}

export async function assertSafeTarContents(
	archive: Uint8Array,
	root: string,
	budget: TarBudget = createTarBudget()
): Promise<void> {
	const parser = new Parser({ gzip: true, strict: true });
	await new Promise<void>((resolveP, reject) => {
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			parser.abort(error instanceof Error ? error : new Error(String(error)));
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const done = () => {
			if (settled) return;
			settled = true;
			resolveP();
		};
		parser.on('entry', (entry) => {
			try {
				accountTarMember(String(entry.path), entry, root, budget);
				entry.resume();
			} catch (error) {
				fail(error);
			}
		});
		parser.on('error', fail);
		parser.on('end', done);
		Readable.from([Buffer.from(archive)])
			.pipe(parser)
			.on('error', fail);
	});
}

export function createTarBudget(limits: ExtractLimits = {}): TarBudget {
	return {
		entries: 0,
		uncompressedBytes: 0,
		maxEntries: limits.maxEntries ?? MAX_EXTRACT_ENTRIES,
		maxUncompressedBytes: limits.maxUncompressedBytes ?? MAX_EXTRACT_UNCOMPRESSED_BYTES
	};
}

export interface TarBudget {
	entries: number;
	uncompressedBytes: number;
	maxEntries: number;
	maxUncompressedBytes: number;
}

export function assertAllowedTarMember(entryPath: string, type: string | undefined): void {
	if (type === undefined || !isAllowedTarEntryType(type)) {
		throw generic(
			`refusing archive member ${entryPath}: type ${type ?? 'unknown'} is not a regular file or directory`
		);
	}
}

export function destinationUnderRoot(root: string, entryPath: string): string | undefined {
	const normalized = normalizeEntryPath(entryPath);
	if (normalized === undefined) {
		return undefined;
	}
	const rootResolved = resolve(root);
	const dest = resolve(rootResolved, normalized);
	const prefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
	if (dest !== rootResolved && !dest.startsWith(prefix)) {
		return undefined;
	}
	return dest;
}

export function normalizeEntryPath(entryPath: string): string | undefined {
	const replaced = entryPath.replaceAll('\\', '/');
	if (
		replaced.includes('\0') ||
		replaced.startsWith('/') ||
		replaced.includes('..') ||
		/^[a-zA-Z]:/.test(replaced)
	) {
		return undefined;
	}
	const normalized = normalize(replaced);
	if (normalized.startsWith('..') || normalized.split(sep).includes('..') || normalized === '') {
		return undefined;
	}
	return normalized;
}

function accountTarMember(
	entryPath: string,
	entry: unknown,
	root: string,
	budget: TarBudget
): void {
	if (isMetaTarMember(entry)) {
		throw generic(
			`refusing archive member ${entryPath}: type ${tarEntryType(entry) ?? 'unknown'} is not a regular file or directory`
		);
	}
	const type = tarEntryType(entry);
	assertAllowedTarMember(entryPath, type);
	if (destinationUnderRoot(root, entryPath) === undefined) {
		throw generic(`refusing archive member with unsafe path: ${entryPath}`);
	}
	budget.entries += 1;
	if (budget.entries > budget.maxEntries) {
		throw generic('archive entry count exceeds limit');
	}
	if (type !== undefined && isRegularTarFileType(type)) {
		const size = tarEntrySize(entry);
		if (size === undefined || !Number.isFinite(size) || size < 0) {
			throw generic(`archive regular file ${entryPath} is missing a usable size`);
		}
		budget.uncompressedBytes += size;
		if (budget.uncompressedBytes > budget.maxUncompressedBytes) {
			throw generic('archive uncompressed size exceeds limit');
		}
	}
}

function isMetaTarMember(entry: unknown): boolean {
	if (!entry || typeof entry !== 'object') {
		return false;
	}
	if ('meta' in entry && entry.meta === true) {
		return true;
	}
	const type = tarEntryType(entry);
	return (
		type === 'ExtendedHeader' ||
		type === 'GlobalExtendedHeader' ||
		type === 'NextFileHasLongPath' ||
		type === 'NextFileHasLongLinkpath' ||
		type === 'OldGnuLongPath' ||
		type === 'OldExtendedHeader'
	);
}

function tarEntryType(entry: unknown): string | undefined {
	if (!entry || typeof entry !== 'object' || !('type' in entry)) {
		return undefined;
	}
	return typeof entry.type === 'string' ? entry.type : undefined;
}

function tarEntrySize(entry: unknown): number | undefined {
	if (!entry || typeof entry !== 'object' || !('size' in entry)) {
		return undefined;
	}
	return typeof entry.size === 'number' ? entry.size : undefined;
}

async function locateBundle(
	fs: FileSystem,
	destDir: string,
	manifest: ReleaseManifest
): Promise<ExtractedBundle> {
	const main = join(destDir, manifest.worker.main);
	const assetsDirectory = join(destDir, manifest.worker.assetsDirectory);
	const migrationsDirectory = join(destDir, manifest.worker.migrationsDirectory);
	if (!(await fs.exists(main))) {
		throw generic(`extracted bundle is missing worker entry ${manifest.worker.main}`);
	}
	if (!(await fs.exists(assetsDirectory))) {
		throw generic(
			`extracted bundle is missing assets directory ${manifest.worker.assetsDirectory}`
		);
	}
	if (!(await fs.exists(migrationsDirectory))) {
		throw generic(
			`extracted bundle is missing migrations directory ${manifest.worker.migrationsDirectory}`
		);
	}
	return {
		root: destDir,
		main,
		assetsDirectory,
		migrationsDirectory,
		configPath: join(destDir, 'wrangler.jsonc')
	};
}
