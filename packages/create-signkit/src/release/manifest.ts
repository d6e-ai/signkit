import { MIGRATION_POLICY_COMPATIBILITY, SIGNKIT_REPOSITORY } from '../constants.js';
import { generic } from '../cli/errors.js';
import type { ReleaseChannel } from '../cli/parse.js';
import { assertSafeRelativePosixPath, uniqueEnvIdentifiers } from './paths.js';
import { channelFromReleaseTag } from './semver.js';

export interface ReleaseBundleInfo {
	assetName: string;
	contentType: string;
	size: number;
	sha256: string;
}

export interface ReleaseWorkerInfo {
	main: string;
	compatibilityDate: string;
	compatibilityFlags: string[];
	assetsDirectory: string;
	migrationsDirectory: string;
}

export interface ReleaseManifest {
	schemaVersion: 1;
	kind: 'signkit-cloudflare-release';
	repository: typeof SIGNKIT_REPOSITORY;
	tag: string;
	commit: string;
	channel: ReleaseChannel;
	createdAt: string;
	bundle: ReleaseBundleInfo;
	worker: ReleaseWorkerInfo;
	bindings: {
		d1: string;
		r2: string;
		assets: string;
		email: string;
	};
	requiredSecrets: string[];
	requiredVars: string[];
	migrationPolicy: {
		compatibility: typeof MIGRATION_POLICY_COMPATIBILITY;
		notes: string;
	};
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const BUNDLE_NAME_PATTERN = /^signkit-cloudflare-[A-Za-z0-9._-]+\.tar\.gz$/;

export function parseReleaseManifest(
	raw: string,
	expected?: { tag?: string; commit?: string }
): ReleaseManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw generic('release manifest is not valid JSON');
	}
	if (!isObject(parsed)) {
		throw generic('release manifest must be an object');
	}
	if (parsed.schemaVersion !== 1) {
		throw generic(`unsupported release manifest schemaVersion: ${String(parsed.schemaVersion)}`);
	}
	if (parsed.kind !== 'signkit-cloudflare-release') {
		throw generic('release manifest kind must be signkit-cloudflare-release');
	}
	if (parsed.repository !== SIGNKIT_REPOSITORY) {
		throw generic(`release manifest repository must be ${SIGNKIT_REPOSITORY}`);
	}
	if (typeof parsed.tag !== 'string' || parsed.tag.length === 0) {
		throw generic('release manifest tag is required');
	}
	let derivedChannel: ReleaseChannel;
	try {
		derivedChannel = channelFromReleaseTag(parsed.tag);
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
	if (expected?.tag && parsed.tag !== expected.tag) {
		throw generic(`release manifest tag ${parsed.tag} does not match expected tag ${expected.tag}`);
	}
	if (typeof parsed.commit !== 'string' || !COMMIT_PATTERN.test(parsed.commit)) {
		throw generic('release manifest commit must be a 40-character lowercase SHA-1');
	}
	if (expected?.commit && parsed.commit !== expected.commit) {
		throw generic('release manifest commit does not match the GitHub release target commit');
	}
	if (parsed.channel !== 'stable' && parsed.channel !== 'beta') {
		throw generic('release manifest channel must be stable or beta');
	}
	if (parsed.channel !== derivedChannel) {
		throw generic(
			`release manifest channel ${parsed.channel} does not match semver prerelease of tag ${parsed.tag}`
		);
	}
	if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) {
		throw generic('release manifest createdAt must be an ISO-8601 timestamp');
	}
	const bundle = parseBundle(parsed.bundle);
	const worker = parseWorker(parsed.worker);
	const bindings = parseBindings(parsed.bindings);
	if (!Array.isArray(parsed.requiredSecrets)) {
		throw generic('release manifest requiredSecrets must be a string array');
	}
	if (!Array.isArray(parsed.requiredVars)) {
		throw generic('release manifest requiredVars must be a string array');
	}
	let requiredSecrets: string[];
	let requiredVars: string[];
	try {
		requiredSecrets = uniqueEnvIdentifiers(parsed.requiredSecrets, 'requiredSecrets');
		requiredVars = uniqueEnvIdentifiers(parsed.requiredVars, 'requiredVars');
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
	if (!isObject(parsed.migrationPolicy)) {
		throw generic('release manifest migrationPolicy is required');
	}
	if (parsed.migrationPolicy.compatibility !== MIGRATION_POLICY_COMPATIBILITY) {
		throw generic('release manifest migrationPolicy.compatibility is not the supported value');
	}
	if (
		typeof parsed.migrationPolicy.notes !== 'string' ||
		parsed.migrationPolicy.notes.length === 0
	) {
		throw generic('release manifest migrationPolicy.notes is required');
	}
	return {
		schemaVersion: 1,
		kind: 'signkit-cloudflare-release',
		repository: SIGNKIT_REPOSITORY,
		tag: parsed.tag,
		commit: parsed.commit,
		channel: parsed.channel,
		createdAt: parsed.createdAt,
		bundle,
		worker,
		bindings,
		requiredSecrets,
		requiredVars,
		migrationPolicy: {
			compatibility: MIGRATION_POLICY_COMPATIBILITY,
			notes: parsed.migrationPolicy.notes
		}
	};
}

function parseBundle(value: unknown): ReleaseBundleInfo {
	if (!isObject(value)) {
		throw generic('release manifest bundle is required');
	}
	if (typeof value.assetName !== 'string' || !BUNDLE_NAME_PATTERN.test(value.assetName)) {
		throw generic('release manifest bundle.assetName is invalid');
	}
	if (typeof value.contentType !== 'string' || value.contentType.length === 0) {
		throw generic('release manifest bundle.contentType is required');
	}
	if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 1) {
		throw generic('release manifest bundle.size must be a positive integer');
	}
	if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
		throw generic('release manifest bundle.sha256 must be a 64-character lowercase hex digest');
	}
	return {
		assetName: value.assetName,
		contentType: value.contentType,
		size: value.size,
		sha256: value.sha256
	};
}

function parseWorker(value: unknown): ReleaseWorkerInfo {
	if (!isObject(value)) {
		throw generic('release manifest worker is required');
	}
	if (typeof value.main !== 'string') {
		throw generic('release manifest worker.main is invalid');
	}
	try {
		assertSafeRelativePosixPath(value.main, 'worker.main');
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
	if (typeof value.compatibilityDate !== 'string') {
		throw generic('release manifest worker.compatibilityDate is required');
	}
	if (
		!Array.isArray(value.compatibilityFlags) ||
		!value.compatibilityFlags.every((flag) => typeof flag === 'string')
	) {
		throw generic('release manifest worker.compatibilityFlags must be a string array');
	}
	if (typeof value.assetsDirectory !== 'string') {
		throw generic('release manifest worker.assetsDirectory is invalid');
	}
	if (typeof value.migrationsDirectory !== 'string') {
		throw generic('release manifest worker.migrationsDirectory is invalid');
	}
	try {
		assertSafeRelativePosixPath(value.assetsDirectory, 'worker.assetsDirectory');
		assertSafeRelativePosixPath(value.migrationsDirectory, 'worker.migrationsDirectory');
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
	return {
		main: value.main,
		compatibilityDate: value.compatibilityDate,
		compatibilityFlags: value.compatibilityFlags,
		assetsDirectory: value.assetsDirectory,
		migrationsDirectory: value.migrationsDirectory
	};
}

function parseBindings(value: unknown): ReleaseManifest['bindings'] {
	if (!isObject(value)) {
		throw generic('release manifest bindings are required');
	}
	for (const key of ['d1', 'r2', 'assets', 'email'] as const) {
		if (typeof value[key] !== 'string' || value[key].length === 0) {
			throw generic(`release manifest bindings.${key} is required`);
		}
	}
	return {
		d1: value.d1 as string,
		r2: value.r2 as string,
		assets: value.assets as string,
		email: value.email as string
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
