import { Buffer } from 'node:buffer';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BACKUP_DIR_MODE, BACKUP_FILE_MODE } from '../constants.js';
import { generic } from '../cli/errors.js';
import type { FileSystem } from '../runtime/fs.js';

export const RECOVERY_SECRET_NAMES = [
	'DELIVERY_ENCRYPTION_KEY',
	'SESSION_ENCRYPTION_KEY',
	'DELIVERY_WORKER_SECRET',
	'D6E_AUTH_CLIENT_ID',
	'D6E_AUTH_CLIENT_SECRET'
] as const;
export const SMTP_RECOVERY_SECRET_NAME = 'SIGNKIT_SMTP_PASSWORD' as const;

export type RecoverySecretName =
	(typeof RECOVERY_SECRET_NAMES)[number] | typeof SMTP_RECOVERY_SECRET_NAME;

export type RecoverySecretMap = Record<(typeof RECOVERY_SECRET_NAMES)[number], string> &
	Partial<Record<typeof SMTP_RECOVERY_SECRET_NAME, string>>;

export interface OAuthSecretInput {
	D6E_AUTH_CLIENT_ID: string;
	D6E_AUTH_CLIENT_SECRET: string;
}

export interface InitialSecretInput extends OAuthSecretInput {
	SIGNKIT_SMTP_PASSWORD?: string;
}

export interface EnsureRecoverySecretsOptions {
	fs: FileSystem;
	recoveryPath: string;
	requiredSecrets: readonly string[];
	oauth: unknown;
	smtpPassword?: string;
	randomBytes?: (size: number) => Uint8Array;
}

export interface ReuseRecoverySecretsOptions {
	fs: FileSystem;
	recoveryPath: string;
	requiredSecrets?: readonly string[];
}

export interface RecoveryTarget {
	accountId: string;
	workerName: string;
}

export interface EnsureRecoveryBindingOptions extends RecoveryTarget {
	fs: FileSystem;
	recoveryPath: string;
	allowCreate: boolean;
}

export interface StageRecoverySecretsOptions {
	fs: FileSystem;
	recoveryPath: string;
	outputPath: string;
	secretNames: readonly string[];
	expectedFingerprint: string;
}

export interface RecoverySecretsResult {
	path: string;
	fingerprint: string;
	created: boolean;
}

export const RECOVERY_DIR_MODE: number = BACKUP_DIR_MODE;
export const RECOVERY_FILE_MODE: number = BACKUP_FILE_MODE;
export const MAX_RECOVERY_FILE_BYTES: number = 16 * 1024;
export const MAX_STDIN_BYTES: number = 16 * 1024;
export const MAX_OAUTH_SECRET_LENGTH: number = 1024;
export const MAX_SMTP_PASSWORD_LENGTH: number = 4096;
export const MAX_RECOVERY_PATH_LENGTH: number = 4096;

const RECOVERY_BINDING_SCHEMA_VERSION: number = 1;
const MAX_RECOVERY_BINDING_BYTES: number = 4096;

const OAUTH_SECRET_KEYS: readonly string[] = ['D6E_AUTH_CLIENT_ID', 'D6E_AUTH_CLIENT_SECRET'];
const SORTED_RECOVERY_KEYS: readonly string[] = [...RECOVERY_SECRET_NAMES].sort();
const BASE64_32_PATTERN: RegExp = /^[A-Za-z0-9+/]{43}=$/;
const SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/;

export function resolveRecoveryPath(statePath: string): string {
	return join(dirname(statePath), 'recovery.json');
}

export function resolveRecoveryBindingPath(recoveryPath: string): string {
	return join(dirname(recoveryPath), 'recovery-binding.json');
}

export function parseOAuthStdinBytes(raw: Uint8Array): OAuthSecretInput {
	if (raw.byteLength > MAX_STDIN_BYTES) {
		throw generic(`OAuth stdin exceeds the ${MAX_STDIN_BYTES}-byte limit; refusing to parse`);
	}
	const text: string = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw generic(
			'OAuth stdin is not valid JSON; provide exactly D6E_AUTH_CLIENT_ID and D6E_AUTH_CLIENT_SECRET'
		);
	}
	return parseOAuthInput(parsed);
}

export async function readOAuthSecrets(
	readStdin: () => Promise<Uint8Array>
): Promise<OAuthSecretInput> {
	let raw: Uint8Array;
	try {
		raw = await readStdin();
	} catch (error) {
		throw generic(
			`OAuth stdin cannot be read: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	return parseOAuthStdinBytes(raw);
}

export function parseInitialSecretStdinBytes(
	raw: Uint8Array,
	requireSmtpPassword: boolean
): InitialSecretInput {
	if (raw.byteLength > MAX_STDIN_BYTES) {
		throw generic(`secret stdin exceeds the ${MAX_STDIN_BYTES}-byte limit; refusing to parse`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8'));
	} catch {
		throw generic('secret stdin is not valid JSON');
	}
	const oauth: OAuthSecretInput = parseOAuthInput(
		requireSmtpPassword && isRecord(parsed)
			? Object.fromEntries(
					Object.entries(parsed).filter(([key]) => key !== SMTP_RECOVERY_SECRET_NAME)
				)
			: parsed
	);
	if (!requireSmtpPassword) return oauth;
	if (
		!isRecord(parsed) ||
		Object.keys(parsed).sort().join(',') !==
			[...OAUTH_SECRET_KEYS, SMTP_RECOVERY_SECRET_NAME].sort().join(',')
	) {
		throw generic(
			`secret stdin must contain exactly D6E_AUTH_CLIENT_ID, D6E_AUTH_CLIENT_SECRET, and ${SMTP_RECOVERY_SECRET_NAME}`
		);
	}
	assertSmtpPassword(parsed[SMTP_RECOVERY_SECRET_NAME]);
	return { ...oauth, SIGNKIT_SMTP_PASSWORD: parsed[SMTP_RECOVERY_SECRET_NAME] as string };
}

export async function readInitialSecrets(
	readStdin: () => Promise<Uint8Array>,
	requireSmtpPassword: boolean
): Promise<InitialSecretInput> {
	let raw: Uint8Array;
	try {
		raw = await readStdin();
	} catch (error) {
		throw generic(
			`secret stdin cannot be read: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	return parseInitialSecretStdinBytes(raw, requireSmtpPassword);
}

export function createNodeStdinReader(): () => Promise<Uint8Array> {
	return async () => {
		const stdin = process.stdin;
		if (stdin.isTTY) {
			throw generic('OAuth stdin is a terminal; redirect a secure two-key OAuth JSON file instead');
		}
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of stdin) {
			const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
			total += buf.byteLength;
			if (total > MAX_STDIN_BYTES) {
				throw generic(`OAuth stdin exceeds the ${MAX_STDIN_BYTES}-byte limit; refusing to parse`);
			}
			chunks.push(buf);
		}
		const joined = Buffer.concat(chunks);
		return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
	};
}

export function canonicalSecretJson(secrets: RecoverySecretMap): string {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(secrets).sort()) {
		sorted[key] = secrets[key as RecoverySecretName] as string;
	}
	return JSON.stringify(sorted);
}

export function fingerprintSecretMap(secrets: RecoverySecretMap): string {
	return sha256HexString(canonicalSecretJson(secrets));
}

export function sha256HexString(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function ensureRecoverySecrets(
	options: EnsureRecoverySecretsOptions
): Promise<RecoverySecretsResult> {
	const fs: FileSystem = options.fs;
	const recoveryPath: string = options.recoveryPath;
	assertSupportedRecoverySecrets(options.requiredSecrets);
	const reused = await tryReuseRecoverySecrets({
		fs,
		recoveryPath,
		requiredSecrets: options.requiredSecrets
	});
	if (reused) {
		return reused;
	}
	if (options.requiredSecrets.includes(SMTP_RECOVERY_SECRET_NAME)) {
		assertSmtpPassword(options.smtpPassword);
	}
	const oauth: OAuthSecretInput = parseOAuthInput(options.oauth);
	const randomBytes: (size: number) => Uint8Array = options.randomBytes ?? defaultRandomBytes;
	const secrets: RecoverySecretMap = generateSecretMap(oauth, randomBytes, options.smtpPassword);
	const canonical: string = canonicalSecretJson(secrets);
	const bytes: Uint8Array = new TextEncoder().encode(canonical);
	try {
		await fs.writeFileExclusive(recoveryPath, bytes, RECOVERY_FILE_MODE);
	} catch (error) {
		if (isExistError(error)) {
			const raced = await tryReuseRecoverySecrets({ fs, recoveryPath });
			if (raced) {
				return raced;
			}
		}
		throw generic(
			`recovery file at ${recoveryPath} cannot be created exclusively; refusing to overwrite`
		);
	}
	await fs.fsync(recoveryPath);
	await fs.fsync(dirname(recoveryPath));
	return {
		path: recoveryPath,
		fingerprint: sha256HexString(canonical),
		created: true
	};
}

export async function tryReuseRecoverySecrets(
	options: ReuseRecoverySecretsOptions
): Promise<RecoverySecretsResult | undefined> {
	const parentDir = await prepareParentDir(options.fs, options.recoveryPath);
	if (!(await options.fs.exists(options.recoveryPath))) {
		return undefined;
	}
	const reused: RecoverySecretMap = await loadValidRecoveryFile(
		options.fs,
		options.recoveryPath,
		parentDir
	);
	if (options.requiredSecrets) {
		for (const name of validateSecretSubset(options.requiredSecrets)) {
			if (typeof reused[name as RecoverySecretName] !== 'string') {
				throw generic(
					`recovery file at ${options.recoveryPath} is missing required secret ${name}`
				);
			}
		}
	}
	return {
		path: options.recoveryPath,
		fingerprint: fingerprintSecretMap(reused),
		created: false
	};
}

export async function ensureRecoveryBinding(options: EnsureRecoveryBindingOptions): Promise<void> {
	const parentDir: string = await prepareParentDir(options.fs, options.recoveryPath);
	const bindingPath: string = resolveRecoveryBindingPath(options.recoveryPath);
	const expected: string = canonicalRecoveryBinding(options);
	if (await options.fs.exists(bindingPath)) {
		await assertRecoveryBinding(options.fs, bindingPath, parentDir, expected);
		return;
	}
	if (!options.allowCreate) {
		throw generic(`recovery binding at ${bindingPath} is missing`);
	}
	if (await options.fs.exists(options.recoveryPath)) {
		throw generic(
			`recovery binding at ${bindingPath} is missing for existing recovery file ${options.recoveryPath}; refusing to bind retained secrets to a new deployment target`
		);
	}
	try {
		await options.fs.writeFileExclusive(
			bindingPath,
			new TextEncoder().encode(expected),
			RECOVERY_FILE_MODE
		);
	} catch (error) {
		if (isExistError(error)) {
			await assertRecoveryBinding(options.fs, bindingPath, parentDir, expected);
			return;
		}
		throw generic(`recovery binding at ${bindingPath} cannot be created exclusively`);
	}
	await options.fs.fsync(bindingPath);
	await options.fs.fsync(parentDir);
}

export async function stageRecoverySecrets(options: StageRecoverySecretsOptions): Promise<string> {
	const parentDir: string = await prepareParentDir(options.fs, options.recoveryPath);
	const secrets: RecoverySecretMap = await loadValidRecoveryFile(
		options.fs,
		options.recoveryPath,
		parentDir
	);
	if (!SHA256_HEX_PATTERN.test(options.expectedFingerprint)) {
		throw generic('expected recovery fingerprint is invalid');
	}
	const actualFingerprint: string = fingerprintSecretMap(secrets);
	if (actualFingerprint !== options.expectedFingerprint) {
		throw generic(
			`recovery file at ${options.recoveryPath} changed after validation; refusing to stage secrets`
		);
	}
	const names: RecoverySecretName[] = validateSecretSubset(options.secretNames);
	const staged: Partial<RecoverySecretMap> = {};
	for (const name of names) {
		const value: string | undefined = secrets[name];
		if (value === undefined) {
			throw generic(`recovery file at ${options.recoveryPath} is missing required secret ${name}`);
		}
		staged[name] = value;
	}
	const canonical: string = JSON.stringify(staged);
	try {
		await options.fs.writeFileExclusive(
			options.outputPath,
			new TextEncoder().encode(canonical),
			RECOVERY_FILE_MODE
		);
	} catch {
		throw generic(`temporary secrets file at ${options.outputPath} cannot be created exclusively`);
	}
	await options.fs.fsync(options.outputPath);
	return options.outputPath;
}

async function prepareParentDir(fs: FileSystem, recoveryPath: string): Promise<string> {
	assertRecoveryPlatform(process.platform);
	assertValidRecoveryPath(recoveryPath);
	const parentDir: string = dirname(recoveryPath);
	await refuseSymlinkDirent(fs, parentDir, 'recovery directory');
	await fs.mkdir(parentDir, { mode: RECOVERY_DIR_MODE });
	await fs.chmod(parentDir, RECOVERY_DIR_MODE);
	await assertSafeDirectoryMode(fs, parentDir);
	return parentDir;
}

export function assertRecoveryPlatform(platform: NodeJS.Platform): void {
	if (platform === 'win32') {
		throw generic(
			'recovery secret bootstrap is unavailable on Windows because POSIX owner and mode guarantees cannot be enforced; run create-signkit from Linux, macOS, or WSL'
		);
	}
}

function defaultRandomBytes(size: number): Uint8Array {
	const buf = nodeRandomBytes(size);
	return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function generateSecretMap(
	oauth: OAuthSecretInput,
	randomBytes: (size: number) => Uint8Array,
	smtpPassword?: string
): RecoverySecretMap {
	const deliveryEncryptionKey: string = randomBase6432(randomBytes);
	const sessionEncryptionKey: string = randomBase6432(randomBytes);
	const deliveryWorkerSecret: string = randomBase6432(randomBytes);
	const secrets: RecoverySecretMap = {
		DELIVERY_ENCRYPTION_KEY: deliveryEncryptionKey,
		SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
		DELIVERY_WORKER_SECRET: deliveryWorkerSecret,
		D6E_AUTH_CLIENT_ID: oauth.D6E_AUTH_CLIENT_ID,
		D6E_AUTH_CLIENT_SECRET: oauth.D6E_AUTH_CLIENT_SECRET
	};
	if (smtpPassword !== undefined) {
		assertSmtpPassword(smtpPassword);
		secrets.SIGNKIT_SMTP_PASSWORD = smtpPassword;
	}
	return secrets;
}

function randomBase6432(randomBytes: (size: number) => Uint8Array): string {
	const bytes: Uint8Array = randomBytes(32);
	if (bytes.byteLength !== 32) {
		throw generic('secret generator returned an unexpected byte length');
	}
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function assertValidRecoveryPath(recoveryPath: string): void {
	if (typeof recoveryPath !== 'string' || recoveryPath.length === 0) {
		throw generic('recovery path must be a non-empty string');
	}
	if (recoveryPath.length > MAX_RECOVERY_PATH_LENGTH) {
		throw generic('recovery path exceeds the supported length');
	}
	if (recoveryPath.includes('\u0000')) {
		throw generic('recovery path must not contain NUL');
	}
}

export function assertExactRequiredSecrets(requiredSecrets: readonly string[]): void {
	if (!Array.isArray(requiredSecrets)) {
		throw generic('required secrets must be a string array');
	}
	const seen: Set<string> = new Set<string>();
	for (const name of requiredSecrets) {
		if (typeof name !== 'string') {
			throw generic('required secrets must be a string array');
		}
		seen.add(name);
	}
	const expected: Set<string> = new Set<string>(RECOVERY_SECRET_NAMES);
	if (seen.size === expected.size && [...expected].every((name) => seen.has(name))) {
		return;
	}
	const unknown: string[] = [...seen].filter((name) => !expected.has(name)).sort();
	if (unknown.length > 0) {
		throw generic(`unknown required secret names: ${unknown.join(', ')}`);
	}
	throw generic(`required secrets must be exactly ${[...expected].sort().join(', ')}`);
}

function assertSupportedRecoverySecrets(requiredSecrets: readonly string[]): void {
	const names: Set<string> = new Set(requiredSecrets);
	const base: Set<string> = new Set(RECOVERY_SECRET_NAMES);
	const unknown: string[] = [...names]
		.filter((name) => !base.has(name) && name !== SMTP_RECOVERY_SECRET_NAME)
		.sort();
	if (unknown.length > 0) {
		throw generic(`unknown required secret names: ${unknown.join(', ')}`);
	}
	const validBase: boolean = names.size === base.size && [...base].every((name) => names.has(name));
	const validSmtp: boolean =
		names.size === base.size + 1 &&
		[...base].every((name) => names.has(name)) &&
		names.has(SMTP_RECOVERY_SECRET_NAME);
	if (!validBase && !validSmtp) {
		throw generic('required secrets contain an unsupported recovery secret set');
	}
}

function parseOAuthInput(input: unknown): OAuthSecretInput {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw generic(
			'OAuth secrets must be an object with exactly D6E_AUTH_CLIENT_ID and D6E_AUTH_CLIENT_SECRET'
		);
	}
	const record: Record<string, unknown> = input as Record<string, unknown>;
	const keys: string[] = Object.keys(record).sort();
	if (
		keys.length !== OAUTH_SECRET_KEYS.length ||
		keys[0] !== OAUTH_SECRET_KEYS[0] ||
		keys[1] !== OAUTH_SECRET_KEYS[1]
	) {
		throw generic(
			'OAuth secrets must contain exactly D6E_AUTH_CLIENT_ID and D6E_AUTH_CLIENT_SECRET'
		);
	}
	const clientId: unknown = record['D6E_AUTH_CLIENT_ID'];
	const clientSecret: unknown = record['D6E_AUTH_CLIENT_SECRET'];
	assertOAuthValue(clientId, 'D6E_AUTH_CLIENT_ID');
	assertOAuthValue(clientSecret, 'D6E_AUTH_CLIENT_SECRET');
	return {
		D6E_AUTH_CLIENT_ID: clientId as string,
		D6E_AUTH_CLIENT_SECRET: clientSecret as string
	};
}

function assertOAuthValue(value: unknown, name: string): void {
	if (typeof value !== 'string') {
		throw generic(`OAuth secret ${name} must be a string`);
	}
	if (value.length < 1 || value.length > MAX_OAUTH_SECRET_LENGTH) {
		throw generic(`OAuth secret ${name} must be 1-${MAX_OAUTH_SECRET_LENGTH} characters`);
	}
	if (value.includes('\u0000')) {
		throw generic(`OAuth secret ${name} must not contain NUL`);
	}
}

function validateSecretSubset(secretNames: readonly string[]): RecoverySecretName[] {
	if (!Array.isArray(secretNames) || secretNames.length === 0) {
		throw generic('temporary secrets file requires at least one supported secret name');
	}
	const requested: Set<string> = new Set<string>();
	for (const name of secretNames) {
		if (
			typeof name !== 'string' ||
			(!RECOVERY_SECRET_NAMES.includes(name as (typeof RECOVERY_SECRET_NAMES)[number]) &&
				name !== SMTP_RECOVERY_SECRET_NAME)
		) {
			throw generic(`unsupported temporary secret name ${String(name)}`);
		}
		requested.add(name);
	}
	return [...RECOVERY_SECRET_NAMES, SMTP_RECOVERY_SECRET_NAME].filter((name) =>
		requested.has(name)
	);
}

function canonicalRecoveryBinding(target: RecoveryTarget): string {
	assertBindingValue(target.accountId, 'accountId');
	assertBindingValue(target.workerName, 'workerName');
	return JSON.stringify({
		accountId: target.accountId,
		schemaVersion: RECOVERY_BINDING_SCHEMA_VERSION,
		workerName: target.workerName
	});
}

function assertBindingValue(value: string, name: string): void {
	if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
		throw generic(`recovery binding ${name} must be 1-256 characters`);
	}
	if (value.includes('\u0000')) {
		throw generic(`recovery binding ${name} must not contain NUL`);
	}
}

async function assertRecoveryBinding(
	fs: FileSystem,
	bindingPath: string,
	parentDir: string,
	expected: string
): Promise<void> {
	await assertSafeDirectoryMode(fs, parentDir);
	await assertSafeFileMode(fs, bindingPath);
	const st = await fs.stat(bindingPath);
	if (st.size > MAX_RECOVERY_BINDING_BYTES) {
		throw generic(`recovery binding at ${bindingPath} exceeds the size limit`);
	}
	let raw: Uint8Array;
	try {
		raw = await fs.readFileBuffer(bindingPath);
	} catch {
		throw generic(`recovery binding at ${bindingPath} cannot be read`);
	}
	if (raw.byteLength > MAX_RECOVERY_BINDING_BYTES) {
		throw generic(`recovery binding at ${bindingPath} exceeds the size limit`);
	}
	const actual: string = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
	if (actual !== expected) {
		throw generic(
			`recovery binding at ${bindingPath} does not match the selected Cloudflare account and Worker`
		);
	}
}

function assertBase64SecretValue(value: unknown, name: string, recoveryPath: string): void {
	if (typeof value !== 'string') {
		throw generic(`recovery file at ${recoveryPath} has invalid secret ${name}`);
	}
	if (!BASE64_32_PATTERN.test(value)) {
		throw generic(`recovery file at ${recoveryPath} has invalid secret ${name}`);
	}
	let decodedLength: number;
	try {
		decodedLength = Buffer.from(value, 'base64').byteLength;
	} catch {
		throw generic(`recovery file at ${recoveryPath} has invalid secret ${name}`);
	}
	if (decodedLength !== 32) {
		throw generic(`recovery file at ${recoveryPath} has invalid secret ${name}`);
	}
}

function validateSecretMap(value: unknown, recoveryPath: string): RecoverySecretMap {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw generic(`recovery file at ${recoveryPath} is invalid`);
	}
	const record: Record<string, unknown> = value as Record<string, unknown>;
	const keys: string[] = Object.keys(record).sort();
	const baseKeysMatch =
		keys.length === SORTED_RECOVERY_KEYS.length &&
		keys.every((key, index) => key === SORTED_RECOVERY_KEYS[index]);
	const smtpKeys: string[] = [...SORTED_RECOVERY_KEYS, SMTP_RECOVERY_SECRET_NAME].sort();
	const smtpKeysMatch =
		keys.length === smtpKeys.length && keys.every((key, index) => key === smtpKeys[index]);
	if (!baseKeysMatch && !smtpKeysMatch) {
		throw generic(`recovery file at ${recoveryPath} has an unsupported secret set`);
	}
	assertBase64SecretValue(
		record['DELIVERY_ENCRYPTION_KEY'],
		'DELIVERY_ENCRYPTION_KEY',
		recoveryPath
	);
	assertBase64SecretValue(record['SESSION_ENCRYPTION_KEY'], 'SESSION_ENCRYPTION_KEY', recoveryPath);
	assertBase64SecretValue(record['DELIVERY_WORKER_SECRET'], 'DELIVERY_WORKER_SECRET', recoveryPath);
	assertOAuthValue(record['D6E_AUTH_CLIENT_ID'], 'D6E_AUTH_CLIENT_ID');
	assertOAuthValue(record['D6E_AUTH_CLIENT_SECRET'], 'D6E_AUTH_CLIENT_SECRET');
	const secrets: RecoverySecretMap = {
		DELIVERY_ENCRYPTION_KEY: record['DELIVERY_ENCRYPTION_KEY'] as string,
		SESSION_ENCRYPTION_KEY: record['SESSION_ENCRYPTION_KEY'] as string,
		DELIVERY_WORKER_SECRET: record['DELIVERY_WORKER_SECRET'] as string,
		D6E_AUTH_CLIENT_ID: record['D6E_AUTH_CLIENT_ID'] as string,
		D6E_AUTH_CLIENT_SECRET: record['D6E_AUTH_CLIENT_SECRET'] as string
	};
	if (smtpKeysMatch) {
		assertSmtpPassword(record[SMTP_RECOVERY_SECRET_NAME]);
		secrets.SIGNKIT_SMTP_PASSWORD = record[SMTP_RECOVERY_SECRET_NAME] as string;
	}
	return secrets;
}

function assertSmtpPassword(value: unknown): void {
	if (
		typeof value !== 'string' ||
		value.length < 1 ||
		value.length > MAX_SMTP_PASSWORD_LENGTH ||
		value.includes('\u0000')
	) {
		throw generic(
			`${SMTP_RECOVERY_SECRET_NAME} must be 1-${MAX_SMTP_PASSWORD_LENGTH} characters without NUL`
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function refuseSymlinkDirent(fs: FileSystem, path: string, label: string): Promise<void> {
	if (!(await pathExists(fs, path))) {
		return;
	}
	let st;
	try {
		st = await fs.stat(path);
	} catch {
		return;
	}
	if (st.isSymlink) {
		throw generic(`${label} at ${path} is a symlink; refusing to use it`);
	}
}

async function pathExists(fs: FileSystem, path: string): Promise<boolean> {
	try {
		return await fs.exists(path);
	} catch {
		return false;
	}
}

async function assertSafeDirectoryMode(fs: FileSystem, dir: string): Promise<void> {
	const st = await fs.stat(dir);
	if (st.isSymlink) {
		throw generic(`recovery directory at ${dir} is a symlink; refusing to use it`);
	}
	if (!st.isDirectory) {
		throw generic(`recovery directory at ${dir} is not a directory`);
	}
	if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
		throw generic(`recovery directory at ${dir} has unsafe permissions; refusing to use it`);
	}
	assertCurrentUserOwns(st.uid, dir, 'recovery directory');
}

async function assertSafeFileMode(fs: FileSystem, file: string): Promise<void> {
	const st = await fs.stat(file);
	if (st.isSymlink) {
		throw generic(`recovery file at ${file} is a symlink; refusing to use it`);
	}
	if (!st.isFile) {
		throw generic(`recovery file at ${file} is not a regular file`);
	}
	if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
		throw generic(`recovery file at ${file} has unsafe permissions; refusing to use it`);
	}
	assertCurrentUserOwns(st.uid, file, 'recovery file');
}

function assertCurrentUserOwns(uid: number | undefined, path: string, label: string): void {
	if (process.platform === 'win32' || uid === undefined || typeof process.getuid !== 'function') {
		return;
	}
	if (uid !== process.getuid()) {
		throw generic(`${label} at ${path} is not owned by the current user; refusing to use it`);
	}
}

async function loadValidRecoveryFile(
	fs: FileSystem,
	recoveryPath: string,
	parentDir: string
): Promise<RecoverySecretMap> {
	await assertSafeDirectoryMode(fs, parentDir);
	await assertSafeFileMode(fs, recoveryPath);
	const st = await fs.stat(recoveryPath);
	if (st.isSymlink) {
		throw generic(`recovery file at ${recoveryPath} is a symlink; refusing to use it`);
	}
	if (!st.isFile) {
		throw generic(`recovery file at ${recoveryPath} is not a regular file`);
	}
	if (st.size > MAX_RECOVERY_FILE_BYTES) {
		throw generic(`recovery file at ${recoveryPath} exceeds the size limit`);
	}
	let raw: Uint8Array;
	try {
		raw = await fs.readFileBuffer(recoveryPath);
	} catch {
		throw generic(`recovery file at ${recoveryPath} cannot be read`);
	}
	if (raw.byteLength > MAX_RECOVERY_FILE_BYTES) {
		throw generic(`recovery file at ${recoveryPath} exceeds the size limit`);
	}
	const text: string = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw generic(`recovery file at ${recoveryPath} is not valid JSON`);
	}
	const validated: RecoverySecretMap = validateSecretMap(parsed, recoveryPath);
	assertFingerprintShape(fingerprintSecretMap(validated));
	return validated;
}

function assertFingerprintShape(fingerprint: string): void {
	if (!SHA256_HEX_PATTERN.test(fingerprint)) {
		throw generic('recovery fingerprint is invalid');
	}
}

function isExistError(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
	);
}
