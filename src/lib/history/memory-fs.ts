import type { FsClient } from 'isomorphic-git';

type Entry =
	| { kind: 'directory'; children: Set<string>; mtimeMs: number }
	| { kind: 'file'; data: Uint8Array; mtimeMs: number };

class FileSystemError extends Error {
	constructor(
		readonly code: 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EINVAL',
		path: string
	) {
		super(`${code}: ${path}`);
	}
}

class MemoryStats {
	constructor(private readonly entry: Entry) {}
	get size(): number {
		return this.entry.kind === 'file' ? this.entry.data.byteLength : 0;
	}
	get mtimeMs(): number {
		return this.entry.mtimeMs;
	}
	get ctimeMs(): number {
		return this.entry.mtimeMs;
	}
	get mode(): number {
		return this.entry.kind === 'file' ? 0o100644 : 0o040000;
	}
	isFile(): boolean {
		return this.entry.kind === 'file';
	}
	isDirectory(): boolean {
		return this.entry.kind === 'directory';
	}
	isSymbolicLink(): boolean {
		return false;
	}
}

export interface ArchivedFile {
	path: string;
	base64: string;
}

export class MemoryFs {
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();
	private readonly entries = new Map<string, Entry>([
		['/', { kind: 'directory', children: new Set<string>(), mtimeMs: Date.now() }]
	]);

	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		chmod: this.chmod.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this)
	};

	asClient(): FsClient {
		return this;
	}

	async importFiles(files: readonly ArchivedFile[]): Promise<void> {
		for (const file of files) await this.writeFile(file.path, fromBase64(file.base64));
	}

	exportFiles(): ArchivedFile[] {
		return [...this.entries.entries()]
			.filter(
				(entry): entry is [string, Extract<Entry, { kind: 'file' }>] => entry[1].kind === 'file'
			)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([path, entry]) => ({ path, base64: toBase64(entry.data) }));
	}

	private normalize(input: string): string {
		const parts: string[] = [];
		for (const part of input.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return parts.length === 0 ? '/' : `/${parts.join('/')}`;
	}

	private parent(path: string): string {
		const parts = this.normalize(path).split('/').filter(Boolean);
		parts.pop();
		return parts.length === 0 ? '/' : `/${parts.join('/')}`;
	}

	private basename(path: string): string {
		return this.normalize(path).split('/').filter(Boolean).at(-1) ?? '';
	}

	private requireEntry(path: string): Entry {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw new FileSystemError('ENOENT', path);
		return entry;
	}

	private requireDirectory(path: string): Extract<Entry, { kind: 'directory' }> {
		const entry = this.requireEntry(path);
		if (entry.kind !== 'directory') throw new FileSystemError('ENOTDIR', path);
		return entry;
	}

	private async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		const target = this.normalize(path);
		if (target === '/') return;
		const parent = this.parent(target);
		if (!this.entries.has(parent)) {
			if (!options?.recursive) throw new FileSystemError('ENOENT', parent);
			await this.mkdir(parent, { recursive: true });
		}
		if (this.entries.has(target)) return;
		this.entries.set(target, {
			kind: 'directory',
			children: new Set<string>(),
			mtimeMs: Date.now()
		});
		this.requireDirectory(parent).children.add(this.basename(target));
	}

	private async writeFile(path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });
		const bytes =
			typeof data === 'string'
				? this.encoder.encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);
		this.entries.set(target, { kind: 'file', data: bytes, mtimeMs: Date.now() });
		this.requireDirectory(this.parent(target)).children.add(this.basename(target));
	}

	private async readFile(
		path: string,
		options?: string | { encoding?: string }
	): Promise<Uint8Array | string> {
		const entry = this.requireEntry(path);
		if (entry.kind !== 'file') throw new FileSystemError('EISDIR', path);
		const encoding = typeof options === 'string' ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	private async readdir(path: string): Promise<string[]> {
		return [...this.requireDirectory(path).children].sort();
	}

	private async unlink(path: string): Promise<void> {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind !== 'file') throw new FileSystemError('EISDIR', path);
		this.entries.delete(target);
		this.requireDirectory(this.parent(target)).children.delete(this.basename(target));
	}

	private async rmdir(path: string): Promise<void> {
		const target = this.normalize(path);
		const entry = this.requireDirectory(target);
		if (entry.children.size > 0) throw new FileSystemError('ENOTEMPTY', path);
		this.entries.delete(target);
		this.requireDirectory(this.parent(target)).children.delete(this.basename(target));
	}

	private async stat(path: string): Promise<MemoryStats> {
		return new MemoryStats(this.requireEntry(path));
	}
	private async chmod(): Promise<void> {}
	private async readlink(path: string): Promise<never> {
		throw new FileSystemError('EINVAL', path);
	}
	private async symlink(): Promise<never> {
		throw new Error('Symbolic links are not supported');
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
