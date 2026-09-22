import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generic, preflight, unavailable } from '../../cli/errors.js';
import { filterEnvForWrangler, type ProcessRunner } from '../../runtime/process.js';

export interface WranglerInvocation {
	args: string[];
	cwd?: string;
	env: NodeJS.ProcessEnv;
}

export interface WranglerClient {
	whoami(): Promise<Whoami>;
	listD1(): Promise<D1Database[]>;
	createD1(name: string): Promise<D1Database>;
	exportD1(name: string, outputPath: string): Promise<void>;
	listMigrations(options: MigrationCommandOptions): Promise<MigrationList>;
	applyMigrations(options: MigrationCommandOptions): Promise<string[]>;
	r2Exists(name: string): Promise<boolean>;
	createR2(name: string): Promise<void>;
	listSecrets(workerName: string): Promise<string[]>;
	listVersions(workerName: string): Promise<WorkerVersion[]>;
	deployFirst(options: UploadVersionOptions): Promise<DeployResult>;
	uploadVersion(options: UploadVersionOptions): Promise<DeployResult>;
	deployVersion(workerName: string, versionId: string): Promise<void>;
	deployTriggers(options: TriggerDeployOptions): Promise<void>;
	invocations(): readonly WranglerInvocation[];
}

export interface Whoami {
	accounts: Array<{ id: string; name?: string }>;
}

export interface D1Database {
	uuid: string;
	name: string;
}

export interface MigrationList {
	pending: string[];
	applied: string[];
}

export interface WorkerVersion {
	id: string;
	createdOn?: string;
}

export interface UploadVersionOptions {
	cwd: string;
	configPath: string;
	workerName: string;
	keepVars: boolean;
	noBundle: boolean;
	secretsFile?: string;
}

export interface MigrationCommandOptions {
	cwd: string;
	configPath: string;
	database: string;
}

export interface TriggerDeployOptions {
	cwd: string;
	configPath: string;
	workerName: string;
}

export interface DeployResult {
	workerVersionId?: string;
	workerUrl?: string;
	stdout: string;
	aborted: boolean;
}

export interface WranglerClientOptions {
	runner: ProcessRunner;
	accountId: string;
	env: NodeJS.ProcessEnv;
	wranglerBin?: string;
	nodeExecutable?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORKERS_DEV_RE = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;
const LABELLED_WORKER_VERSION_RE =
	/(?:current\s+)?(?:worker\s+)?version id\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const MISSING_WORKER_API_CODES = ['10007', '10006', '10090'] as const;
const MIGRATION_FILENAME_RE = /(\d{4}_[\w.-]+\.sql)/;

export function resolveWranglerBin(from = import.meta.url): string {
	const require = createRequire(from);
	const pkg = require.resolve('wrangler/package.json');
	return join(dirname(pkg), 'bin', 'wrangler.js');
}

export function wranglerUploadArgs(options: UploadVersionOptions): string[] {
	const args = ['--config', options.configPath, '--name', options.workerName];
	if (options.secretsFile) {
		args.push('--secrets-file', options.secretsFile);
	}
	if (options.keepVars) {
		args.push('--keep-vars');
	}
	args.push('--strict');
	if (options.noBundle) {
		args.push('--no-bundle');
	}
	return args;
}

export function wranglerFirstDeployArgs(options: UploadVersionOptions): string[] {
	// The first Worker upload cannot use `versions upload`. Routing is already
	// authoritative in the extracted config, so no separate --domain is added.
	return wranglerUploadArgs(options);
}

export function wranglerMigrationArgs(
	action: 'list' | 'apply',
	options: MigrationCommandOptions
): string[] {
	return ['d1', 'migrations', action, options.database, '--remote', '--config', options.configPath];
}

export function wranglerTriggerDeployArgs(options: TriggerDeployOptions): string[] {
	return ['triggers', 'deploy', '--config', options.configPath, '--name', options.workerName];
}

export function accountIdIsAuthorized(whoami: Whoami, accountId: string): boolean {
	const wanted = accountId.toLowerCase();
	return whoami.accounts.some((account) => account.id.toLowerCase() === wanted);
}

export function assertSelectedAccountAuthorized(whoami: Whoami, accountId: string): void {
	if (!accountIdIsAuthorized(whoami, accountId)) {
		throw preflight('the selected --account-id is not present in this Wrangler session');
	}
}

export function createWranglerClient(options: WranglerClientOptions): WranglerClient {
	const wranglerBin = options.wranglerBin ?? resolveWranglerBin();
	const nodeExecutable = options.nodeExecutable ?? process.execPath;
	const invocations: WranglerInvocation[] = [];
	const childEnv = filterEnvForWrangler(options.env, options.accountId);

	async function run(args: string[], cwd?: string, errorDetail?: 'redacted' | 'hidden') {
		let discoveryCwd: string | undefined;
		const resolvedCwd =
			cwd ?? (discoveryCwd = await mkdtemp(join(tmpdir(), 'create-signkit-wrangler-')));
		try {
			const invocation: WranglerInvocation = { args, cwd: resolvedCwd, env: childEnv };
			invocations.push(invocation);
			const result = await options.runner.run({
				file: nodeExecutable,
				argv: [wranglerBin, ...args],
				cwd: resolvedCwd,
				env: childEnv
			});
			if (result.code !== 0) {
				const detail =
					errorDetail === 'hidden' ? '' : formatWranglerError(result.stderr, result.stdout);
				throw unavailable(`wrangler ${args[0]} failed (exit ${result.code})${detail}`);
			}
			return result;
		} finally {
			if (discoveryCwd) {
				await rm(discoveryCwd, { recursive: true, force: true });
			}
		}
	}

	return {
		invocations() {
			return invocations;
		},
		async whoami() {
			const result = await run(['whoami', '--json'], undefined, 'hidden');
			const parsed = parseJson(result.stdout) as Whoami;
			if (!parsed || !Array.isArray(parsed.accounts)) {
				throw generic('wrangler whoami --json did not include accounts');
			}
			return {
				accounts: parsed.accounts.map((account) => ({
					id: String(account.id ?? '')
				}))
			};
		},
		async listD1() {
			const result = await run(['d1', 'list', '--json']);
			const parsed = parseJson(result.stdout);
			if (!Array.isArray(parsed)) {
				throw generic('wrangler d1 list --json did not return an array');
			}
			return parsed.map((row) => {
				const record = asObject(row);
				const uuid = String(record.uuid ?? record.id ?? '');
				const name = String(record.name ?? '');
				if (!uuid || !name) {
					throw generic('wrangler d1 list returned a row without uuid/name');
				}
				return { uuid, name };
			});
		},
		async createD1(name) {
			const result = await run(['d1', 'create', name]);
			const combined = `${result.stdout}\n${result.stderr}`;
			const match =
				combined.match(/database_id\s*=\s*"?([0-9a-f-]{36})"?/i) ?? combined.match(UUID_RE);
			if (!match) {
				throw generic(`could not parse D1 id from wrangler d1 create ${name}`);
			}
			const uuid = (match[1] ?? match[0]).toLowerCase();
			return { uuid, name };
		},
		async exportD1(name, outputPath) {
			await run(['d1', 'export', name, '--remote', '--output', outputPath, '--skip-confirmation']);
		},
		async listMigrations(options) {
			const result = await run(wranglerMigrationArgs('list', options), options.cwd);
			return parseMigrationList(`${result.stdout}\n${result.stderr}`);
		},
		async applyMigrations(options) {
			await run(wranglerMigrationArgs('apply', options), options.cwd);
			return [];
		},
		async r2Exists(name) {
			try {
				await run(['r2', 'bucket', 'info', name, '--json']);
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/not found|does not exist|couldn't find|404/i.test(message)) {
					return false;
				}
				throw error;
			}
		},
		async createR2(name) {
			await run(['r2', 'bucket', 'create', name]);
		},
		async listSecrets(workerName) {
			try {
				const result = await run(['secret', 'list', '--name', workerName, '--format', 'json']);
				const parsed = parseJson(result.stdout);
				if (!Array.isArray(parsed)) {
					return [];
				}
				return parsed
					.map((row) => {
						const record = asObject(row);
						return typeof record.name === 'string' ? record.name : '';
					})
					.filter(Boolean);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isMissingWorkerError(message)) {
					return [];
				}
				throw error;
			}
		},
		async listVersions(workerName) {
			try {
				const result = await run(['versions', 'list', '--name', workerName, '--json']);
				const parsed = parseJson(result.stdout);
				const rows = Array.isArray(parsed)
					? parsed
					: isObject(parsed) && Array.isArray(parsed.versions)
						? parsed.versions
						: [];
				const versions: WorkerVersion[] = [];
				for (const row of rows) {
					const record = asObject(row);
					const id = String(record.id ?? record.version_id ?? record.versionId ?? '');
					if (id) {
						versions.push({ id, createdOn: optionalString(record.created_on ?? record.createdOn) });
					}
				}
				return sortWorkerVersions(versions);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isMissingWorkerError(message)) {
					return [];
				}
				throw error;
			}
		},
		async uploadVersion(options) {
			const args = wranglerUploadArgs(options);
			const result = await run(['versions', 'upload', ...args], options.cwd);
			return assertSuccessfulUpload(parseDeployResult(result.stdout, result.stderr));
		},
		async deployFirst(options) {
			const args = wranglerFirstDeployArgs(options);
			const result = await run(['deploy', ...args], options.cwd);
			return assertSuccessfulUpload(parseDeployResult(result.stdout, result.stderr));
		},
		async deployVersion(workerName, versionId) {
			await run(['versions', 'deploy', `${versionId}@100`, '--name', workerName, '--yes']);
		},
		async deployTriggers(options) {
			await run(wranglerTriggerDeployArgs(options), options.cwd);
		}
	};
}

export function parseMigrationList(text: string): MigrationList {
	const combined = text.replace(/\r\n/g, '\n');
	if (/no migrations to apply!/i.test(combined)) {
		return { pending: [], applied: [] };
	}
	const header = combined.search(/migrations to be applied:/i);
	const body = header === -1 ? '' : combined.slice(header);
	const pending: string[] = [];
	const seen = new Set<string>();
	for (const line of body.split('\n')) {
		const name = extractMigrationName(line);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		pending.push(name);
	}
	return { pending, applied: [] };
}

function extractMigrationName(line: string): string | undefined {
	return line.match(MIGRATION_FILENAME_RE)?.[1];
}

export function parseDeployResult(stdout: string, stderr: string): DeployResult {
	const combined = `${stdout}\n${stderr}`;
	const aborted = isAbortedDeployOutput(combined);
	const versionId = aborted ? undefined : labelledWorkerVersionId(combined);
	const url = combined.match(WORKERS_DEV_RE)?.[0];
	return { workerVersionId: versionId, workerUrl: url, stdout: combined, aborted };
}

export function isAbortedDeployOutput(text: string): boolean {
	return /(?:^|\n)\s*(?:✖|✘|×|x)?\s*aborted\b|did not (?:upload|deploy)|upload skipped|overwritten by remote|remote (?:configuration|override)|exiting without (?:upload|deploy)|would be overwritten/i.test(
		text
	);
}

export function labelledWorkerVersionId(text: string): string | undefined {
	const match = text.match(LABELLED_WORKER_VERSION_RE);
	return match?.[1]?.toLowerCase();
}

export function assertSuccessfulUpload(
	result: DeployResult
): DeployResult & { workerVersionId: string } {
	if (result.aborted || isAbortedDeployOutput(result.stdout)) {
		throw generic(
			'Wrangler aborted or reported a remote override and did not upload a Worker version'
		);
	}
	if (!result.workerVersionId) {
		throw generic(
			'Wrangler did not report a labelled Worker Version ID; refusing to treat another UUID as the Worker version'
		);
	}
	return { ...result, workerVersionId: result.workerVersionId };
}

export function isMissingWorkerError(text: string): boolean {
	const normalized = text.replace(/\s+/g, ' ');
	if (/script_not_found/i.test(normalized)) {
		return true;
	}
	for (const code of MISSING_WORKER_API_CODES) {
		const codePattern = new RegExp(
			`(?:\\bcode\\s*[:#=]\\s*${code}\\b|\\[\\s*(?:code\\s*[:#=]\\s*)?${code}\\s*\\]|\\(\\s*${code}\\s*\\)|["']${code}["'])`,
			'i'
		);
		if (codePattern.test(normalized)) {
			return true;
		}
	}
	return false;
}

export function sortWorkerVersions(versions: readonly WorkerVersion[]): WorkerVersion[] {
	return versions
		.map((version, index) => ({ version, index }))
		.sort((left, right) => {
			const leftTime = parseCreatedOn(left.version.createdOn);
			const rightTime = parseCreatedOn(right.version.createdOn);
			const leftMissing = leftTime === undefined;
			const rightMissing = rightTime === undefined;
			if (leftMissing && rightMissing) {
				return left.index - right.index;
			}
			if (leftMissing) {
				return 1;
			}
			if (rightMissing) {
				return -1;
			}
			if (rightTime !== leftTime) {
				return rightTime - leftTime;
			}
			return left.index - right.index;
		})
		.map((entry) => entry.version);
}

function parseCreatedOn(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const time = Date.parse(value);
	return Number.isNaN(time) ? undefined : time;
}

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	const start = trimmed.search(/[[{]/);
	if (start === -1) {
		throw generic('expected JSON output from wrangler');
	}
	try {
		return JSON.parse(trimmed.slice(start));
	} catch {
		throw generic('failed to parse JSON output from wrangler');
	}
}

function formatWranglerError(stderr: string, stdout: string): string {
	const text = (stderr || stdout).trim().split(/\r?\n/).slice(0, 8).join('\n');
	return text ? `\n${redactSecrets(text)}` : '';
}

function redactSecrets(text: string): string {
	return text
		.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
		.replace(/(token["\s:=]+)[^\s"]+/gi, '$1[REDACTED]');
}

function asObject(value: unknown): Record<string, unknown> {
	return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
