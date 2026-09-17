import {
	chmod as fsChmod,
	lstat as fsLstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rm,
	writeFile,
	access
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir as osHomedir } from 'node:os';
import { constants as fsConstants } from 'node:fs';

export interface MkdirOptions {
	mode?: number;
}

export interface FileStat {
	mode: number;
	size: number;
	uid?: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymlink: boolean;
}

export interface FileSystem {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	writeFileExclusive(path: string, contents: string | Uint8Array, mode: number): Promise<void>;
	fsync(path: string): Promise<void>;
	mkdir(path: string, options?: MkdirOptions): Promise<void>;
	exists(path: string): Promise<boolean>;
	mkdtemp(prefix: string): Promise<string>;
	rm(path: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	homedir(): string;
	tmpdir(): string;
}

export function createNodeFileSystem(): FileSystem {
	return {
		readFile(path) {
			return readFile(path, 'utf8');
		},
		async readFileBuffer(path) {
			const buf = await readFile(path);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		},
		writeFile(path, contents) {
			return writeFile(path, contents);
		},
		async stat(path) {
			const st = await fsLstat(path);
			return {
				mode: st.mode & 0o777,
				size: st.size,
				uid: st.uid,
				isFile: st.isFile(),
				isDirectory: st.isDirectory(),
				isSymlink: st.isSymbolicLink()
			};
		},
		writeFileExclusive(path, contents, mode) {
			return writeFile(path, contents, { flag: 'wx', mode });
		},
		async fsync(path) {
			const handle = await open(path, 'r');
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		async mkdir(path, options) {
			await mkdir(path, {
				recursive: true,
				...(options?.mode !== undefined ? { mode: options.mode } : {})
			});
		},
		async exists(path) {
			try {
				await access(path, fsConstants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		mkdtemp(prefix) {
			return mkdtemp(prefix);
		},
		rm(path) {
			return rm(path, { recursive: true, force: true });
		},
		async chmod(path, mode) {
			try {
				await fsChmod(path, mode);
			} catch (error) {
				if (process.platform === 'win32') {
					return;
				}
				throw error;
			}
		},
		homedir() {
			return osHomedir();
		},
		tmpdir() {
			return tmpdir();
		}
	};
}
