import { dirname, join } from 'node:path';
import { SECRET_ENV_NAME } from '../constants.js';
import { generic, usage } from '../cli/errors.js';
import type { CommandName, MailProviderId, ProviderId, ReleaseChannel } from '../cli/parse.js';
import type { FileSystem } from '../runtime/fs.js';

export const STATE_SCHEMA_VERSION = 1 as const;

export interface TriggerReconciliationRequired {
	workerVersionId: string;
	releaseVersion: string;
	releaseCommit?: string;
	recordedAt: string;
}

export interface DeploymentState {
	schemaVersion: typeof STATE_SCHEMA_VERSION;
	provider: ProviderId;
	accountId: string;
	workerName: string;
	d1: { name: string; id: string };
	r2: { name: string };
	domain?: string;
	publicOrigin?: string;
	d6eAuthBaseUrl?: string;
	emailFrom?: string;
	emailFromName?: string;
	mailProvider?: MailProviderId;
	smtpHost?: string;
	smtpPort?: number;
	smtpSecure?: boolean;
	smtpUsername?: string;
	/**
	 * Canonicalized (trimmed, lowercased) bootstrap owner email recorded from
	 * `--bootstrap-owner-email`. Non-secret deployment configuration like
	 * `emailFrom`: inherited by later deploy/upgrade runs so the flag only
	 * needs to be passed once. Never a secret; the state secret-guard rejects
	 * secret-looking fields independently.
	 */
	bootstrapOwnerEmail?: string;
	lastD1BackupPath?: string;
	channel: ReleaseChannel;
	version?: string;
	commit?: string;
	/** D1 schema compatibility epoch recorded from the deployed release manifest. */
	schemaEpoch?: string;
	lastCommand?: CommandName;
	updatedAt: string;
	lastWorkerVersionId?: string;
	previousWorkerVersionId?: string;
	triggerReconciliationRequired?: TriggerReconciliationRequired;
	appliedMigrations?: string[];
	adopted?: boolean;
}

export interface StateStore {
	path: string;
	load(): Promise<DeploymentState | undefined>;
	save(state: DeploymentState): Promise<void>;
}

const FORBIDDEN_STATE_KEYS = /secret|token|password|api[_-]?key|credential|private/i;

export function resolveStatePath(
	fs: FileSystem,
	env: NodeJS.ProcessEnv,
	explicit?: string
): string {
	if (explicit) {
		return explicit;
	}
	const xdg = env.XDG_STATE_HOME?.trim();
	const root = xdg && xdg.length > 0 ? xdg : join(fs.homedir(), '.local', 'state');
	return join(root, 'create-signkit', 'state.json');
}

export function resolveBackupsDir(statePath: string): string {
	return join(dirname(statePath), 'backups');
}

export function d1BackupFileName(d1Name: string, now: Date): string {
	const safe = d1Name
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	const stamp = now.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
	return `d1-${safe || 'database'}-${stamp}.sql`;
}

export function createStateStore(fs: FileSystem, path: string): StateStore {
	return {
		path,
		async load() {
			if (!(await fs.exists(path))) {
				return undefined;
			}
			const raw = await fs.readFile(path);
			return parseState(raw);
		},
		async save(state) {
			assertStateHasNoSecrets(state);
			await fs.mkdir(dirname(path));
			await fs.writeFile(path, `${JSON.stringify(state, null, '\t')}\n`);
		}
	};
}

export function parseState(raw: string): DeploymentState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw generic('deployment state file is not valid JSON');
	}
	assertNoSecretKeys(parsed);
	if (!isObject(parsed)) {
		throw generic('deployment state file must be an object');
	}
	if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
		throw generic(`unsupported deployment state schemaVersion: ${String(parsed.schemaVersion)}`);
	}
	if (
		parsed.provider !== 'cloudflare' &&
		parsed.provider !== 'node' &&
		parsed.provider !== 'vercel'
	) {
		throw generic('deployment state provider is invalid');
	}
	if (typeof parsed.accountId !== 'string' || typeof parsed.workerName !== 'string') {
		throw generic('deployment state is missing accountId or workerName');
	}
	if (
		!isObject(parsed.d1) ||
		typeof parsed.d1.name !== 'string' ||
		typeof parsed.d1.id !== 'string'
	) {
		throw generic('deployment state D1 record is invalid');
	}
	if (!isObject(parsed.r2) || typeof parsed.r2.name !== 'string') {
		throw generic('deployment state R2 record is invalid');
	}
	if (parsed.channel !== 'stable' && parsed.channel !== 'beta') {
		throw generic('deployment state channel is invalid');
	}
	if (typeof parsed.updatedAt !== 'string') {
		throw generic('deployment state updatedAt is invalid');
	}
	if (parsed.schemaEpoch !== undefined && typeof parsed.schemaEpoch !== 'string') {
		throw generic('deployment state schemaEpoch is invalid');
	}
	if (parsed.triggerReconciliationRequired !== undefined) {
		assertTriggerReconciliationMarker(parsed.triggerReconciliationRequired);
	}
	if (
		parsed.mailProvider !== undefined &&
		parsed.mailProvider !== 'cloudflare' &&
		parsed.mailProvider !== 'smtp'
	) {
		throw generic('deployment state mailProvider is invalid');
	}
	if (
		parsed.smtpHost !== undefined &&
		(typeof parsed.smtpHost !== 'string' ||
			parsed.smtpHost.length < 1 ||
			parsed.smtpHost.length > 253 ||
			/\s|\0/.test(parsed.smtpHost))
	) {
		throw generic('deployment state smtpHost is invalid');
	}
	if (
		parsed.smtpPort !== undefined &&
		(typeof parsed.smtpPort !== 'number' ||
			!Number.isInteger(parsed.smtpPort) ||
			parsed.smtpPort < 1 ||
			parsed.smtpPort > 65_535 ||
			parsed.smtpPort === 25)
	) {
		throw generic('deployment state smtpPort is invalid');
	}
	if (parsed.smtpSecure !== undefined && typeof parsed.smtpSecure !== 'boolean') {
		throw generic('deployment state smtpSecure is invalid');
	}
	if (
		parsed.smtpUsername !== undefined &&
		(typeof parsed.smtpUsername !== 'string' ||
			parsed.smtpUsername.length < 1 ||
			parsed.smtpUsername.length > 256 ||
			parsed.smtpUsername.includes('\0'))
	) {
		throw generic('deployment state smtpUsername is invalid');
	}
	return parsed as unknown as DeploymentState;
}

function assertTriggerReconciliationMarker(value: unknown): void {
	if (!isObject(value)) {
		throw generic('deployment state triggerReconciliationRequired is invalid');
	}
	if (
		typeof value.workerVersionId !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.workerVersionId)
	) {
		throw generic('deployment state triggerReconciliationRequired.workerVersionId is invalid');
	}
	if (
		typeof value.releaseVersion !== 'string' ||
		value.releaseVersion.length < 1 ||
		value.releaseVersion.length > 35 ||
		!/^[\x21-\x7e]+$/.test(value.releaseVersion)
	) {
		throw generic('deployment state triggerReconciliationRequired.releaseVersion is invalid');
	}
	if (
		value.releaseCommit !== undefined &&
		(typeof value.releaseCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(value.releaseCommit))
	) {
		throw generic('deployment state triggerReconciliationRequired.releaseCommit is invalid');
	}
	if (typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))) {
		throw generic('deployment state triggerReconciliationRequired.recordedAt is invalid');
	}
}

export function assertStateHasNoSecrets(value: unknown): void {
	assertNoSecretKeys(value);
}

function assertNoSecretKeys(value: unknown, trail = '$'): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			assertNoSecretKeys(item, `${trail}[${index}]`);
		}
		return;
	}
	if (!isObject(value)) {
		if (typeof value === 'string' && looksStoredSecret(value)) {
			throw usage(`deployment state at ${trail} looks like a secret and is refused`);
		}
		return;
	}
	for (const [key, item] of Object.entries(value)) {
		if (FORBIDDEN_STATE_KEYS.test(key) || SECRET_ENV_NAME.test(key)) {
			throw usage(`deployment state must not contain secret field "${key}"`);
		}
		assertNoSecretKeys(item, `${trail}.${key}`);
	}
}

function looksStoredSecret(value: string): boolean {
	return /^(sk-|cf-|signkit_|AKIA)/.test(value) || value.includes('-----BEGIN');
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
