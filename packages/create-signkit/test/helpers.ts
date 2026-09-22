import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import {
	D1_SCHEMA_EPOCH,
	MIGRATION_POLICY_COMPATIBILITY,
	MIGRATION_POLICY_NOTES,
	REQUIRED_WORKER_SECRETS,
	REQUIRED_WORKER_VARS,
	SIGNKIT_REPOSITORY
} from '../src/constants.js';
import type { ParsedCommand } from '../src/cli/parse.js';
import type { FileStat, FileSystem, MkdirOptions } from '../src/runtime/fs.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/runtime/http.js';
import type { CommandResult, ProcessRunner, RunCommandRequest } from '../src/runtime/process.js';
import type { ReleaseManifest } from '../src/release/manifest.js';
import type { BundleExtractor, ExtractedBundle } from '../src/release/extract.js';
import type { ReleaseResolver, ResolvedRelease } from '../src/release/github.js';
import type { ReleaseProvenance } from '../src/release/provenance.js';
import type {
	D1Database,
	DeployResult,
	MigrationCommandOptions,
	MigrationList,
	TriggerDeployOptions,
	UploadVersionOptions,
	Whoami,
	WorkerVersion,
	WranglerClient,
	WranglerInvocation
} from '../src/providers/cloudflare/wrangler.js';
import { sha256Hex } from '../src/release/github.js';

export const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const D1_ID = '11111111-1111-1111-1111-111111111111';
export const BOOTSTRAP_OWNER_EMAIL = 'owner@example.com';
export const WORKER_VERSION = '22222222-2222-2222-2222-222222222222';
export const PREVIOUS_VERSION = '33333333-3333-3333-3333-333333333333';

export async function writeCloudflareState(
	fs: MemoryFileSystem,
	overrides: Record<string, unknown> = {}
): Promise<MemoryFileSystem> {
	await fs.writeFile(
		'/xdg/state/create-signkit/state.json',
		JSON.stringify({
			schemaVersion: 1,
			provider: 'cloudflare',
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			d1: { name: 'signkit', id: D1_ID },
			r2: { name: 'signkit-objects' },
			publicOrigin: 'https://signkit.example.workers.dev',
			bootstrapOwnerEmail: BOOTSTRAP_OWNER_EMAIL,
			channel: 'stable',
			schemaEpoch: D1_SCHEMA_EPOCH,
			updatedAt: '2026-09-15T00:00:00.000Z',
			lastWorkerVersionId: PREVIOUS_VERSION,
			...overrides
		})
	);
	return fs;
}

export class MemoryFileSystem implements FileSystem {
	readonly files = new Map<string, string | Uint8Array>();
	readonly dirs = new Set<string>();
	readonly symlinks = new Set<string>();
	readonly writes: string[] = [];
	readonly modes = new Map<string, number>();
	readonly mkdirCalls: Array<{ path: string; mode?: number }> = [];
	readonly chmodCalls: Array<{ path: string; mode: number }> = [];
	readonly fsyncCalls: string[] = [];
	readonly exclusiveWrites: Array<{ path: string; mode: number }> = [];
	readonly chmodFailures = new Set<string>();
	private temp = 0;

	constructor(private readonly home = '/home/operator') {}

	async readFile(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`ENOENT ${path}`);
		return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`ENOENT ${path}`);
		return typeof value === 'string' ? new TextEncoder().encode(value) : value;
	}

	async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
		if (this.dirs.has(path)) {
			const error = new Error(`EISDIR ${path}`) as Error & { code: string };
			error.code = 'EISDIR';
			throw error;
		}
		this.files.set(path, contents);
		this.writes.push(path);
	}

	async stat(path: string): Promise<FileStat> {
		if (this.symlinks.has(path)) {
			return {
				mode: this.modes.get(path) ?? 0o777,
				size: 0,
				isFile: false,
				isDirectory: false,
				isSymlink: true
			};
		}
		if (this.dirs.has(path)) {
			return {
				mode: this.modes.get(path) ?? 0o755,
				size: 0,
				isFile: false,
				isDirectory: true,
				isSymlink: false
			};
		}
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`ENOENT ${path}`);
		const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
		return {
			mode: this.modes.get(path) ?? 0o644,
			size,
			isFile: true,
			isDirectory: false,
			isSymlink: false
		};
	}

	async writeFileExclusive(
		path: string,
		contents: string | Uint8Array,
		mode: number
	): Promise<void> {
		if (this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path)) {
			const error = new Error(`EEXIST ${path}`) as Error & { code: string };
			error.code = 'EEXIST';
			throw error;
		}
		this.files.set(path, contents);
		this.modes.set(path, mode);
		this.writes.push(path);
		this.exclusiveWrites.push({ path, mode });
	}

	async fsync(path: string): Promise<void> {
		if (this.symlinks.has(path) || (!this.files.has(path) && !this.dirs.has(path))) {
			throw new Error(`ENOENT ${path}`);
		}
		this.fsyncCalls.push(path);
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		this.mkdirCalls.push({ path, mode: options?.mode });
		if (this.symlinks.has(path)) {
			const error = new Error(`EEXIST ${path}`) as Error & { code: string };
			error.code = 'EEXIST';
			throw error;
		}
		this.dirs.add(path);
		if (options?.mode !== undefined) {
			this.modes.set(path, options.mode);
		}
	}

	async exists(path: string): Promise<boolean> {
		if (this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path)) {
			return true;
		}
		for (const key of this.files.keys()) {
			if (key.startsWith(`${path}/`)) return true;
		}
		for (const key of this.dirs) {
			if (key.startsWith(`${path}/`)) return true;
		}
		return false;
	}

	async mkdtemp(prefix: string): Promise<string> {
		this.temp += 1;
		const path = `${prefix}${this.temp}`;
		this.dirs.add(path);
		this.modes.set(path, 0o700);
		return path;
	}

	async rm(path: string): Promise<void> {
		for (const key of [...this.files.keys()]) {
			if (key === path || key.startsWith(`${path}/`)) {
				this.files.delete(key);
				this.modes.delete(key);
			}
		}
		for (const key of [...this.dirs]) {
			if (key === path || key.startsWith(`${path}/`)) {
				this.dirs.delete(key);
				this.modes.delete(key);
			}
		}
		for (const key of [...this.symlinks]) {
			if (key === path || key.startsWith(`${path}/`)) {
				this.symlinks.delete(key);
				this.modes.delete(key);
			}
		}
	}

	async chmod(path: string, mode: number): Promise<void> {
		this.chmodCalls.push({ path, mode });
		if (this.chmodFailures.has(path)) {
			throw new Error(`EPERM chmod ${path}`);
		}
		if (!(await this.exists(path))) {
			throw new Error(`ENOENT ${path}`);
		}
		this.modes.set(path, mode);
	}

	homedir(): string {
		return this.home;
	}

	tmpdir(): string {
		return '/tmp';
	}
}

export class FakeHttp implements HttpClient {
	readonly requests: HttpRequest[] = [];
	private readonly routes = new Map<string, HttpResponse[]>();

	on(url: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
		const list = this.routes.get(url) ?? [];
		list.push(encodeResponse(url, body, status, headers));
		this.routes.set(url, list);
	}

	replace(url: string, body: unknown, status = 200, headers: Record<string, string> = {}): void {
		this.routes.set(url, [encodeResponse(url, body, status, headers)]);
	}

	async request(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		const host = new URL(request.url).hostname;
		if (!request.allowedHosts.has(host)) {
			throw new Error(`refusing download from unexpected host ${host}`);
		}
		const list = this.routes.get(request.url);
		if (!list || list.length === 0) {
			return { url: request.url, status: 404, headers: {}, body: new Uint8Array() };
		}
		const response = list.length > 1 ? list.shift()! : list[0]!;
		if (response.body.byteLength > request.maxBytes) {
			throw new Error(`response body exceeded limit ${request.maxBytes}`);
		}
		return response;
	}
}

function encodeResponse(
	url: string,
	body: unknown,
	status: number,
	headers: Record<string, string>
): HttpResponse {
	const encoded =
		typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
	const bytes = typeof encoded === 'string' ? new TextEncoder().encode(encoded) : encoded;
	return { url, status, headers, body: bytes };
}

export class FakeWrangler implements WranglerClient {
	readonly calls: string[] = [];
	d1: D1Database[] = [];
	r2 = new Set<string>();
	secrets = new Map<string, string[]>();
	versions = new Map<string, WorkerVersion[]>();
	pendingMigrations: string[] = [];
	appliedMigrations: string[] = [];
	accounts: Whoami['accounts'] = [{ id: ACCOUNT_ID, name: 'signkit-lab' }];
	fs?: MemoryFileSystem;
	deployResult: DeployResult = {
		workerVersionId: WORKER_VERSION,
		workerUrl: 'https://signkit.example.workers.dev',
		stdout: `Deployed signkit\nVersion ID: ${WORKER_VERSION}\nhttps://signkit.example.workers.dev`,
		aborted: false
	};
	failTriggerDeploy = false;
	failFirstDeploy = false;
	publishVersionBeforeFirstDeployFailure = false;
	leavePendingAfterApply = false;
	lastConfig?: string;
	readonly migrationCalls: MigrationCommandOptions[] = [];
	readonly recordedInvocations: WranglerInvocation[] = [];
	readonly deployOptions: UploadVersionOptions[] = [];
	readonly stagedSecrets: string[] = [];

	invocations(): readonly WranglerInvocation[] {
		return this.recordedInvocations;
	}

	async whoami(): Promise<Whoami> {
		this.calls.push('whoami');
		return { accounts: this.accounts.map((account) => ({ id: account.id })) };
	}

	async listD1(): Promise<D1Database[]> {
		this.calls.push('listD1');
		return [...this.d1];
	}

	async createD1(name: string): Promise<D1Database> {
		this.calls.push(`createD1:${name}`);
		const created = { uuid: D1_ID, name };
		this.d1.push(created);
		return created;
	}

	async exportD1(name: string, outputPath: string): Promise<void> {
		this.calls.push(`exportD1:${name}:${outputPath}`);
		if (this.fs) {
			await this.fs.writeFile(outputPath, `-- d1 backup ${name}\n`);
		}
	}

	async listMigrations(options: MigrationCommandOptions): Promise<MigrationList> {
		this.calls.push(`listMigrations:${options.database}`);
		this.migrationCalls.push(options);
		this.recordedInvocations.push({
			args: [
				'd1',
				'migrations',
				'list',
				options.database,
				'--remote',
				'--config',
				options.configPath
			],
			cwd: options.cwd,
			env: {}
		});
		return { pending: [...this.pendingMigrations], applied: [...this.appliedMigrations] };
	}

	async applyMigrations(options: MigrationCommandOptions): Promise<string[]> {
		this.calls.push(`applyMigrations:${options.database}`);
		this.migrationCalls.push(options);
		this.recordedInvocations.push({
			args: [
				'd1',
				'migrations',
				'apply',
				options.database,
				'--remote',
				'--config',
				options.configPath
			],
			cwd: options.cwd,
			env: {}
		});
		const pending = [...this.pendingMigrations];
		if (!this.leavePendingAfterApply) {
			this.appliedMigrations.push(...pending);
			this.pendingMigrations = [];
		}
		return pending;
	}

	async r2Exists(name: string): Promise<boolean> {
		this.calls.push(`r2Exists:${name}`);
		return this.r2.has(name);
	}

	async createR2(name: string): Promise<void> {
		this.calls.push(`createR2:${name}`);
		this.r2.add(name);
	}

	async listSecrets(workerName: string): Promise<string[]> {
		this.calls.push(`listSecrets:${workerName}`);
		return [...(this.secrets.get(workerName) ?? [])];
	}

	async listVersions(workerName: string): Promise<WorkerVersion[]> {
		this.calls.push(`listVersions:${workerName}`);
		return [...(this.versions.get(workerName) ?? [])];
	}

	async deployFirst(options: UploadVersionOptions): Promise<DeployResult> {
		this.calls.push(`deploy:${options.workerName}`);
		this.deployOptions.push(options);
		this.lastConfig = this.fs
			? await this.fs.readFile(options.configPath).catch(() => undefined)
			: undefined;
		if (this.fs && options.secretsFile) {
			this.stagedSecrets.push(await this.fs.readFile(options.secretsFile));
		}
		if (this.failFirstDeploy) {
			if (this.publishVersionBeforeFirstDeployFailure) {
				this.ensureWorker(options.workerName);
			}
			throw new Error('first deploy failed');
		}
		this.ensureWorker(options.workerName);
		return this.deployResult;
	}

	async uploadVersion(options: UploadVersionOptions): Promise<DeployResult> {
		this.calls.push(`uploadVersion:${options.workerName}`);
		this.deployOptions.push(options);
		this.lastConfig = this.fs
			? await this.fs.readFile(options.configPath).catch(() => undefined)
			: undefined;
		if (this.fs && options.secretsFile) {
			this.stagedSecrets.push(await this.fs.readFile(options.secretsFile));
		}
		this.ensureWorker(options.workerName);
		return this.deployResult;
	}

	async deployVersion(workerName: string, versionId: string): Promise<void> {
		this.calls.push(`deployVersion:${workerName}:${versionId}`);
	}

	async deployTriggers(options: TriggerDeployOptions): Promise<void> {
		this.calls.push(`deployTriggers:${options.workerName}`);
		this.recordedInvocations.push({
			args: ['triggers', 'deploy', '--config', options.configPath, '--name', options.workerName],
			cwd: options.cwd,
			env: {}
		});
		if (this.failTriggerDeploy) {
			throw new Error('trigger deployment failed');
		}
	}

	seedReadyWorker(workerName = 'signkit'): void {
		this.d1 = [{ uuid: D1_ID, name: 'signkit' }];
		this.r2.add('signkit-objects');
		this.secrets.set(workerName, [...REQUIRED_WORKER_SECRETS]);
		this.versions.set(workerName, [{ id: PREVIOUS_VERSION }]);
	}

	private ensureWorker(workerName: string): void {
		const versions = this.versions.get(workerName) ?? [];
		versions.unshift({ id: this.deployResult.workerVersionId ?? WORKER_VERSION });
		this.versions.set(workerName, versions);
	}
}

export class RecordingProcessRunner implements ProcessRunner {
	readonly requests: RunCommandRequest[] = [];
	handler: (request: RunCommandRequest) => CommandResult = () => ({
		code: 0,
		stdout: '{}',
		stderr: ''
	});

	async run(request: RunCommandRequest): Promise<CommandResult> {
		this.requests.push(request);
		return this.handler(request);
	}
}

export function command(overrides: Partial<ParsedCommand> = {}): ParsedCommand {
	return {
		kind: 'command',
		provider: 'cloudflare',
		command: 'plan',
		accountId: ACCOUNT_ID,
		workerName: 'signkit',
		d1: 'signkit',
		r2: 'signkit-objects',
		mailProvider: 'cloudflare',
		version: 'latest',
		channel: 'stable',
		yes: true,
		json: true,
		overrides: { workerName: false, d1: false, r2: false, domain: false },
		...overrides,
		overrides: {
			workerName: false,
			d1: false,
			r2: false,
			domain: false,
			publicOrigin: false,
			d6eAuthBaseUrl: false,
			emailFrom: false,
			emailFromName: false,
			mailProvider: false,
			smtpHost: false,
			smtpPort: false,
			smtpSecure: false,
			smtpUsername: false,
			bootstrapOwnerEmail: false,
			...overrides.overrides
		}
	};
}

export function sampleManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
	return {
		schemaVersion: 1,
		kind: 'signkit-cloudflare-release',
		repository: SIGNKIT_REPOSITORY,
		tag: 'v1.2.3',
		commit: COMMIT,
		channel: 'stable',
		createdAt: '2026-09-15T00:00:00.000Z',
		bundle: {
			assetName: 'signkit-cloudflare-v1.2.3.tar.gz',
			contentType: 'application/gzip',
			size: 12,
			sha256: sha256Hex(new TextEncoder().encode('bundle-bytes'))
		},
		worker: {
			main: 'worker/index.js',
			compatibilityDate: '2026-09-11',
			compatibilityFlags: ['nodejs_compat'],
			assetsDirectory: 'assets',
			migrationsDirectory: 'migrations/d1'
		},
		bindings: { d1: 'DB', r2: 'OBJECTS', assets: 'ASSETS', email: 'EMAIL' },
		requiredSecrets: [...REQUIRED_WORKER_SECRETS],
		requiredVars: [...REQUIRED_WORKER_VARS],
		migrationPolicy: {
			schemaEpoch: D1_SCHEMA_EPOCH,
			compatibility: MIGRATION_POLICY_COMPATIBILITY,
			notes: MIGRATION_POLICY_NOTES
		},
		...overrides
	};
}

export function sampleBundleBytes(): Uint8Array {
	return new TextEncoder().encode('bundle-bytes');
}

export function sampleProvenance(manifest = sampleManifest()): ReleaseProvenance {
	return {
		status: 'verified',
		mode: 'online',
		repository: SIGNKIT_REPOSITORY,
		workflow: '.github/workflows/release-cloudflare-bundle.yml',
		sourceRef: `refs/tags/${manifest.tag}`,
		sourceCommit: manifest.commit,
		subjectName: manifest.bundle.assetName,
		subjectSha256: manifest.bundle.sha256,
		predicateType: 'https://slsa.dev/provenance/v1',
		buildType: 'https://actions.github.io/buildtypes/workflow/v1',
		attestationCount: 1,
		trustRoot: 'sigstore-public-good'
	};
}

export function fakeExtractor(fs: MemoryFileSystem): BundleExtractor {
	return {
		async extract(_archive, destDir, manifest): Promise<ExtractedBundle> {
			const main = join(destDir, manifest.worker.main);
			const assetsDirectory = join(destDir, manifest.worker.assetsDirectory);
			const migrationsDirectory = join(destDir, manifest.worker.migrationsDirectory);
			await fs.writeFile(main, 'export default { fetch() { return new Response("ok") } }');
			await fs.writeFile(join(assetsDirectory, 'index.html'), '<html></html>');
			await fs.writeFile(join(migrationsDirectory, '0001_core.sql'), 'SELECT 1;');
			return {
				root: destDir,
				main,
				assetsDirectory,
				migrationsDirectory,
				configPath: join(destDir, 'wrangler.jsonc')
			};
		}
	};
}

export function fakeReleases(
	manifest = sampleManifest()
): ReleaseResolver & { downloads: number; resolveCalls: number } {
	const bundle = sampleBundleBytes();
	const resolved: ResolvedRelease = {
		tag: manifest.tag,
		channel: manifest.channel,
		prerelease: false,
		commit: manifest.commit,
		manifest: {
			...manifest,
			bundle: { ...manifest.bundle, size: bundle.byteLength, sha256: sha256Hex(bundle) }
		},
		manifestUrl: `https://github.com/${SIGNKIT_REPOSITORY}/releases/download/${manifest.tag}/signkit-cloudflare-manifest.json`,
		bundleUrl: `https://github.com/${SIGNKIT_REPOSITORY}/releases/download/${manifest.tag}/${manifest.bundle.assetName}`
	};
	return {
		downloads: 0,
		resolveCalls: 0,
		async resolve() {
			this.resolveCalls += 1;
			return resolved;
		},
		async prepareBundle() {
			this.downloads += 1;
			return {
				bytes: bundle,
				provenance: sampleProvenance({
					...resolved.manifest,
					bundle: { ...resolved.manifest.bundle }
				})
			};
		}
	};
}

export function githubReleaseJson(options: {
	tag: string;
	draft?: boolean;
	prerelease?: boolean;
	commit?: string;
	manifestName?: string;
	bundleName?: string;
	bundleSize?: number;
}): Record<string, unknown> {
	const bundleName = options.bundleName ?? `signkit-cloudflare-${options.tag}.tar.gz`;
	const manifestName = options.manifestName ?? 'signkit-cloudflare-manifest.json';
	return {
		tag_name: options.tag,
		draft: options.draft ?? false,
		prerelease: options.prerelease ?? false,
		target_commitish: options.commit ?? COMMIT,
		assets: [
			{
				name: manifestName,
				size: 128,
				browser_download_url: `https://github.com/${SIGNKIT_REPOSITORY}/releases/download/${options.tag}/${manifestName}`,
				content_type: 'application/json'
			},
			{
				name: bundleName,
				size: options.bundleSize ?? sampleBundleBytes().byteLength,
				browser_download_url: `https://github.com/${SIGNKIT_REPOSITORY}/releases/download/${options.tag}/${bundleName}`,
				content_type: 'application/gzip'
			}
		]
	};
}
