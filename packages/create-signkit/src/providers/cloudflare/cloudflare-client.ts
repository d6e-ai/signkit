import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generic, preflight, unavailable } from '../../cli/errors.js';
import { filterEnvForCloudflareCli, type ProcessRunner } from '../../runtime/process.js';
import {
	assertSuccessfulUpload,
	createWranglerClient,
	isMissingWorkerError,
	sortWorkerVersions,
	type DeployResult,
	type TriggerDeployOptions,
	type UploadVersionOptions,
	type WorkerVersion,
	type WranglerClient
} from './wrangler.js';

export { assertSuccessfulUpload, isMissingWorkerError, sortWorkerVersions };
export type { DeployResult, TriggerDeployOptions, UploadVersionOptions, WorkerVersion };

/**
 * CLI-neutral port consumed by the reconciler.
 *
 * The installed `cf` CLI (1.0.0-beta.14) runs: whoami (`accounts list`),
 * listD1/createD1 (`d1 list`/`d1 create`), D1 remote migrations
 * (`d1 migrations list`/`apply` for pending, `d1 query` for applied
 * history), R2 (`r2 buckets get`/`create`), secret-name inspection, and exact
 * version traffic publication (`workers deployments create`).
 *
 * Worker version inspection, uploads, trigger reconciliation, and D1 export
 * retain the Wrangler compatibility client. The authenticated v1 archive
 * contains Wrangler configuration, not cf
 * Build Output. Native upload must first prove equivalent no-rebundle, strict
 * override, retained-var, secret-file, and partial-failure recovery behavior
 * before replacing that path. See docs/architecture/create-signkit.md for the
 * next-phase gate.
 */
export interface CloudflareClient {
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
	invocations(): readonly CloudflareInvocation[];
}

export interface CloudflareInvocation {
	args: string[];
	cwd?: string;
	env: NodeJS.ProcessEnv;
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

export interface MigrationCommandOptions {
	d1Id: string;
	migrationsDir: string;
}

export interface CloudflareClientOptions {
	runner: ProcessRunner;
	accountId: string;
	env: NodeJS.ProcessEnv;
	cfBin?: string;
	wranglerBin?: string;
	nodeExecutable?: string;
}

export function resolveCfBin(from = import.meta.url): string {
	const require = createRequire(from);
	const pkg = require.resolve('cf/package.json');
	return join(dirname(pkg), 'bin', 'cf');
}

export function accountIdIsAuthorized(whoami: Whoami, accountId: string): boolean {
	const wanted = accountId.toLowerCase();
	return whoami.accounts.some((account) => account.id.toLowerCase() === wanted);
}

export function assertSelectedAccountAuthorized(whoami: Whoami, accountId: string): void {
	if (!accountIdIsAuthorized(whoami, accountId)) {
		throw preflight('the selected --account-id is not present in this cf CLI session');
	}
}

export function createCloudflareClient(options: CloudflareClientOptions): CloudflareClient {
	const cfBin = options.cfBin ?? resolveCfBin();
	const nodeExecutable = options.nodeExecutable ?? process.execPath;
	const invocations: CloudflareInvocation[] = [];
	const childEnv = filterEnvForCloudflareCli(options.env, options.accountId);
	const wrangler: WranglerClient = createWranglerClient({
		runner: options.runner,
		accountId: options.accountId,
		env: options.env,
		wranglerBin: options.wranglerBin,
		nodeExecutable: options.nodeExecutable
	});

	async function run(args: string[], cwd?: string, errorDetail?: 'redacted' | 'hidden') {
		let discoveryCwd: string | undefined;
		const resolvedCwd = cwd ?? (discoveryCwd = await mkdtemp(join(tmpdir(), 'create-signkit-cf-')));
		try {
			const invocation: CloudflareInvocation = { args, cwd: resolvedCwd, env: childEnv };
			invocations.push(invocation);
			const result = await options.runner.run({
				file: nodeExecutable,
				argv: [cfBin, ...args],
				cwd: resolvedCwd,
				env: childEnv
			});
			if (result.code !== 0) {
				const detail = errorDetail === 'hidden' ? '' : formatCfError(result.stderr, result.stdout);
				throw unavailable(
					`cf ${args[0]} ${args[1] ?? ''}`.trim() + ` failed (exit ${result.code})${detail}`
				);
			}
			return result;
		} finally {
			if (discoveryCwd) {
				await rm(discoveryCwd, { recursive: true, force: true });
			}
		}
	}

	// cf prints only the current API page, discarding result_info. Exhaust every
	// bounded page before the reconciler may conclude that a resource is absent.
	async function readPages(
		command: string[],
		label: string,
		idKey: string,
		hidden = false
	): Promise<unknown[]> {
		const rows: unknown[] = [];
		const identities = new Set<string>();
		for (let page = 1; page <= 100; page += 1) {
			const result = await run(
				[...command, '--page', String(page), '--per-page', '50'],
				undefined,
				hidden ? 'hidden' : undefined
			);
			const batch = parseJsonArray(result.stdout, label);
			if (batch.length > 50) throw generic(`${label} exceeded the requested page size`);
			for (const row of batch) {
				const id = asObject(row)[idKey];
				if (typeof id !== 'string' || id.length === 0 || identities.has(id)) {
					throw generic(`${label} returned a malformed or repeated resource identity`);
				}
				identities.add(id);
				rows.push(row);
			}
			if (batch.length < 50) return rows;
		}
		throw generic(`${label} exceeded the discovery page limit; resource absence is not proven`);
	}

	return {
		invocations() {
			return invocations;
		},
		async whoami() {
			const rows = await readPages(['accounts', 'list'], 'cf accounts list', 'id', true);
			return {
				accounts: rows.map((row) => {
					const record = asObject(row);
					return { id: String(record.id ?? ''), name: optionalString(record.name) };
				})
			};
		},
		async listD1() {
			const rows = await readPages(['d1', 'list'], 'cf d1 list', 'uuid');
			return rows.map((row) => {
				const record = asObject(row);
				const uuid = String(record.uuid ?? record.id ?? '');
				const name = String(record.name ?? '');
				if (!uuid || !name) {
					throw generic('cf d1 list returned a row without uuid/name');
				}
				return { uuid, name };
			});
		},
		async createD1(name) {
			const result = await run(['d1', 'create', '--name', name]);
			const record = asObject(parseJsonValue(result.stdout, 'cf d1 create'));
			const uuid = String(record.uuid ?? record.id ?? '');
			if (!uuid) {
				throw generic(`cf d1 create ${name} did not return a database id`);
			}
			return { uuid, name: String(record.name ?? name) };
		},
		async exportD1(name, outputPath) {
			await wrangler.exportD1(name, outputPath);
		},
		async listMigrations(options) {
			const pendingResult = await run([
				'd1',
				'migrations',
				'list',
				options.d1Id,
				'--dir',
				options.migrationsDir
			]);
			const pending = parseCfMigrationNames(pendingResult.stdout, 'cf d1 migrations list');
			const queryResult = await run([
				'd1',
				'query',
				options.d1Id,
				'--sql',
				'SELECT name FROM d1_migrations ORDER BY id'
			]);
			const applied = parseD1QueryAppliedNames(queryResult.stdout);
			return { pending, applied };
		},
		async applyMigrations(options) {
			await run(['d1', 'migrations', 'apply', options.d1Id, '--dir', options.migrationsDir]);
			return [];
		},
		async r2Exists(name) {
			try {
				await run(['r2', 'buckets', 'get', name]);
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
			await run(['r2', 'buckets', 'create', '--name', name]);
		},
		async listSecrets(workerName) {
			try {
				const result = await run(['workers', 'secrets', 'list', '--worker', workerName]);
				const rows = parseJsonValue(result.stdout, 'cf workers secrets list');
				if (!Array.isArray(rows) || rows.length > 1000) {
					throw generic('cf workers secrets list returned a malformed or oversized list');
				}
				const names = new Set<string>();
				for (const row of rows) {
					const name = asObject(row).name;
					if (typeof name !== 'string' || name.length === 0 || names.has(name)) {
						throw generic('cf workers secrets list returned a malformed or duplicate name');
					}
					names.add(name);
				}
				return [...names];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isMissingWorkerError(message)) return [];
				throw error;
			}
		},
		async listVersions(workerName) {
			return wrangler.listVersions(workerName);
		},
		async deployFirst(options) {
			return wrangler.deployFirst(options);
		},
		async uploadVersion(options) {
			return wrangler.uploadVersion(options);
		},
		async deployVersion(workerName, versionId) {
			if (!isUuid(versionId)) throw generic('a valid Worker version id is required');
			const createResult = await run([
				'workers',
				'deployments',
				'create',
				'--worker',
				workerName,
				'--strategy',
				'percentage',
				'--versions',
				JSON.stringify([{ version_id: versionId, percentage: 100 }])
			]);
			const createId = extractCfDeploymentCreateId(
				createResult.stdout,
				'cf workers deployments create'
			);
			const listResult = await run(['workers', 'deployments', 'list', '--worker', workerName]);
			const active = parseCfActiveDeployment(listResult.stdout, 'cf workers deployments list');
			const versions = active.versions;
			const selected =
				Array.isArray(versions) && versions.length === 1 ? asObject(versions[0]) : undefined;
			if (
				typeof active.id !== 'string' ||
				!isUuid(active.id) ||
				active.id.toLowerCase() !== createId.toLowerCase() ||
				active.strategy !== 'percentage' ||
				!selected ||
				typeof selected.version_id !== 'string' ||
				selected.version_id.toLowerCase() !== versionId.toLowerCase() ||
				selected.percentage !== 100
			) {
				throw generic('cf Worker deployment did not confirm the exact requested version at 100%');
			}
		},
		async deployTriggers(options) {
			await wrangler.deployTriggers(options);
		}
	};
}

/**
 * `cf d1 migrations list` on the verified 1.0.0-beta.14 build emits a JSON
 * array of rows shaped `{"Name":"0045_...sql"}` (capital `Name`, not the
 * lowercase `name`/`filename` keys Wrangler's text tables would scrape).
 * Any other shape is treated as a hard failure rather than an empty pending
 * list, since silently returning no pending migrations would let a broken
 * parser bypass the schema-epoch check below it.
 */
export function parseCfMigrationNames(stdout: string, label: string): string[] {
	const parsed = parseJsonValue(stdout, label);
	if (!Array.isArray(parsed)) {
		throw generic(`expected a JSON array of migration rows from ${label}`);
	}
	return parsed.map((row) => {
		const record = asObject(row);
		const name = record.Name;
		if (typeof name !== 'string' || name.length === 0) {
			throw generic(`${label} returned a row without a Name field`);
		}
		return name;
	});
}

/**
 * Applied migration history cannot come from `cf d1 migrations list` (it
 * only reports what is pending), so it is read back with `cf d1 query`
 * against the d1_migrations bookkeeping table Wrangler/D1 maintain. The SDK
 * query result is an array of per-statement results, each with an explicit
 * `success` flag; a missing or false flag is a hard failure, never an empty
 * applied list.
 */
export function parseD1QueryAppliedNames(stdout: string): string[] {
	const parsed = parseJsonValue(stdout, 'cf d1 query');
	if (!Array.isArray(parsed) || parsed.length !== 1) {
		throw generic('expected exactly one query result from cf d1 query');
	}
	const applied: string[] = [];
	for (const entry of parsed) {
		const record = asObject(entry);
		if (record.success !== true) {
			throw generic('cf d1 query reported an unsuccessful result for the d1_migrations lookup');
		}
		const rows = record.results;
		if (!Array.isArray(rows)) {
			throw generic('cf d1 query result is missing a results array');
		}
		for (const row of rows) {
			const name = asObject(row).name;
			if (typeof name !== 'string' || name.length === 0) {
				throw generic('cf d1 query returned a d1_migrations row without a name');
			}
			applied.push(name);
		}
	}
	return applied;
}

function parseJsonValue(stdout: string, label: string): unknown {
	const trimmed = stdout.trim();
	const start = trimmed.search(/[[{]/);
	if (start === -1) {
		throw generic(`expected JSON output from ${label}`);
	}
	try {
		return JSON.parse(trimmed.slice(start));
	} catch {
		throw generic(`failed to parse JSON output from ${label}`);
	}
}

/**
 * Shared Cloudflare API envelope unwrap. `success` is only ever trusted when
 * it is the literal boolean `true`; anything else (including an absent
 * `success` key, meaning the response is the bare resource rather than an
 * envelope) is handled by the caller, and an explicit non-`true` value is a
 * hard failure rather than a shape we fall back to interpreting directly.
 */
function unwrapCfEnvelope(record: Record<string, unknown>, label: string): Record<string, unknown> {
	if (!('success' in record)) return record;
	if (record.success !== true) {
		throw generic(`${label} reported an unsuccessful response`);
	}
	if (!isObject(record.result)) {
		throw generic(`${label} returned a successful envelope without a result object`);
	}
	return record.result;
}

/**
 * Carry only the required deployment id from the create response into the
 * authoritative traffic readback. Successful API envelopes are accepted;
 * malformed replies, error envelopes, and missing/non-UUID ids fail closed.
 */
function extractCfDeploymentCreateId(stdout: string, label: string): string {
	const parsed = parseJsonValue(stdout, label);
	if (!isObject(parsed)) {
		throw generic(`expected a JSON object from ${label}`);
	}
	const unwrapped = unwrapCfEnvelope(parsed, label);
	const id = unwrapped.id;
	if (typeof id !== 'string' || !isUuid(id)) {
		throw generic(`${label} did not return a valid deployment id`);
	}
	return id;
}

/**
 * Traffic confirmation is read back from `cf workers deployments list`,
 * whose verified beta14 shape is
 * `{deployments:[{id,strategy,versions:[{version_id,percentage}]}]}` with
 * the active deployment first; a `{success,result}` envelope wrapping that
 * same shape is also accepted. This readback is the sole source of truth
 * for whether traffic actually moved — any error envelope, non-object
 * payload, or missing/non-array/empty `deployments` fails closed rather
 * than assuming the requested version went live.
 */
function parseCfActiveDeployment(stdout: string, label: string): Record<string, unknown> {
	const parsed = parseJsonValue(stdout, label);
	if (!isObject(parsed)) {
		throw generic(`expected a JSON object from ${label}`);
	}
	const unwrapped = unwrapCfEnvelope(parsed, label);
	const deployments = unwrapped.deployments;
	if (!Array.isArray(deployments) || deployments.length === 0) {
		throw generic(`${label} did not return any deployments`);
	}
	const active = deployments[0];
	if (!isObject(active)) {
		throw generic(`${label} returned a malformed deployment`);
	}
	return active;
}

function parseJsonArray(stdout: string, label: string): unknown[] {
	const parsed = parseJsonValue(stdout, label);
	if (Array.isArray(parsed)) {
		return parsed;
	}
	if (isObject(parsed) && Array.isArray(parsed.result)) {
		return parsed.result;
	}
	throw generic(`expected a JSON array from ${label}`);
}

function formatCfError(stderr: string, stdout: string): string {
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

function isUuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	);
}
