import { join } from 'node:path';
import {
	BACKUP_DIR_MODE,
	BACKUP_FILE_MODE,
	MIGRATION_POLICY_NOTES,
	PACKAGE_NAME,
	REQUIRED_WORKER_SECRETS,
	SMTP_PASSWORD_SECRET
} from '../../constants.js';
import { resolveEffectiveConfig, type EffectiveTarget } from '../../cli/effective-config.js';
import { conflict, generic, preflight, usage } from '../../cli/errors.js';
import type { CommandName, ParsedCommand } from '../../cli/parse.js';
import { isValidEmailAddress } from '../../cli/urls.js';
import type {
	PreparedReleaseBundle,
	ReleaseResolver,
	ResolvedRelease
} from '../../release/github.js';
import type { ReleaseProvenance } from '../../release/provenance.js';
import type { BundleExtractor, ExtractedBundle } from '../../release/extract.js';
import type { FileSystem } from '../../runtime/fs.js';
import type { HttpClient } from '../../runtime/http.js';
import {
	assertExactRequiredSecrets,
	ensureRecoveryBinding,
	ensureRecoverySecrets,
	readInitialSecrets,
	RECOVERY_DIR_MODE,
	resolveRecoveryPath,
	stageRecoverySecrets,
	tryReuseRecoverySecrets,
	type InitialSecretInput
} from '../../recovery/bootstrap.js';
import {
	createStateStore,
	d1BackupFileName,
	resolveBackupsDir,
	resolveStatePath,
	type DeploymentState,
	type StateStore
} from '../../state/store.js';
import { renderWranglerConfig } from './config.js';
import { selectProductionWorkersDevOrigin, smokeCheck } from './smoke.js';
import { posixRelativeToRoot } from '../../release/paths.js';
import {
	assertSelectedAccountAuthorized,
	assertSuccessfulUpload,
	sortWorkerVersions,
	type D1Database,
	type WorkerVersion,
	type WranglerClient
} from './wrangler.js';

export interface ReconcileRuntime {
	fs: FileSystem;
	http: HttpClient;
	releases: ReleaseResolver;
	wrangler: WranglerClient;
	extractor: BundleExtractor;
	now: () => Date;
	env: NodeJS.ProcessEnv;
	smokeAttempts?: number;
	smokeBackoffMs?: number;
	smokeTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	readStdin?: () => Promise<Uint8Array>;
	recoveryPath?: string;
	randomBytes?: (size: number) => Uint8Array;
}

export interface PlanStep {
	id: string;
	summary: string;
	mutating: boolean;
}

export interface RollbackReport {
	attempted: boolean;
	performed: boolean;
	workerRolledBack: boolean;
	d1RolledBack: false;
	previousWorkerVersionId?: string;
	guidance: string;
}

export interface ReconcileResult {
	exitCode: number;
	command: CommandName;
	provider: 'cloudflare';
	version?: string;
	commit?: string;
	plan: PlanStep[];
	mutations: string[];
	statePath: string;
	workerUrl?: string;
	d1BackupPath?: string;
	missingSecrets: string[];
	drift: string[];
	rollback?: RollbackReport;
	message: string;
	bootstrapWarning: string;
	migrationPolicy: string;
	recoveryPath?: string;
	recoveryFingerprint?: string;
	provenance?: ReleaseProvenance;
}

const BOOTSTRAP_WARNING_CONFIGURED =
	'The bootstrap owner email is configured as a non-secret Worker var. Claim the initial owner immediately via POST /api/v1/instance/bootstrap before advertising this URL: only the matching verified identity can claim it, and the window stays open until then.';

const BOOTSTRAP_WARNING_MISSING =
	'No bootstrap owner email is configured: an uninitialized instance fails closed and cannot be claimed. Pass --bootstrap-owner-email <email> to deploy or upgrade; create-signkit applies it as a non-secret Worker var.';

function bootstrapWarningFor(target: EffectiveTarget): string {
	return target.bootstrapOwnerEmail ? BOOTSTRAP_WARNING_CONFIGURED : BOOTSTRAP_WARNING_MISSING;
}

export async function reconcileCloudflare(
	input: ParsedCommand,
	runtime: ReconcileRuntime
): Promise<ReconcileResult> {
	if (input.command !== 'plan' && !input.yes) {
		throw usage('mutating commands require --yes');
	}

	const stateStore = createStateStore(runtime.fs, resolvePath(runtime, input));
	const existing = await stateStore.load();
	assertCloudflareState(existing);
	if (input.command === 'upgrade' && !existing) {
		throw conflict(
			'upgrade requires recorded local state; adopt the existing Worker before upgrading rather than taking it over'
		);
	}
	const target = resolveEffectiveConfig(input, existing);
	assertSelectedAccountAuthorized(await runtime.wrangler.whoami(), target.accountId);
	const remote = await inspectRemote(runtime.wrangler, target);
	assertUpgradeRouteUnchanged(input, existing);
	const drift = detectDrift(existing, target, remote);

	if (drift.length > 0 && input.command !== 'adopt' && input.command !== 'plan') {
		throw conflict(
			`remote deployment drifted from local state (${drift.join('; ')}). Re-run with --cloudflare adopt and the intended --worker-name/--d1/--r2 values to record the existing resources.`
		);
	}

	if (input.command === 'upgrade' && !remote.workerExists) {
		throw conflict('upgrade requires an existing Worker; adopt the resources first');
	}

	if (input.command === 'adopt') {
		return adopt(input, target, runtime, stateStore, existing, remote);
	}

	const release = await runtime.releases.resolve({
		version: input.version,
		channel: input.channel
	});
	assertSupportedSecretTaxonomy(release, runtime, stateStore.path);
	const preparedBundle = await runtime.releases.prepareBundle(release);
	const plan = buildPlan(input, existing, target, remote, release);
	if (input.command === 'plan') {
		return {
			exitCode: 0,
			command: 'plan',
			provider: 'cloudflare',
			version: release.tag,
			commit: release.commit,
			provenance: preparedBundle.provenance,
			plan,
			mutations: [],
			statePath: stateStore.path,
			missingSecrets: missingSecrets(
				remote.secretNames,
				requiredSecretsFor(target, release.manifest.requiredSecrets)
			),
			drift,
			message: 'plan only; no Cloudflare resources were created or changed',
			bootstrapWarning: bootstrapWarningFor(target),
			migrationPolicy: MIGRATION_POLICY_NOTES
		};
	}

	return deployOrUpgrade(
		input,
		target,
		runtime,
		stateStore,
		existing,
		remote,
		release,
		preparedBundle,
		plan
	);
}

async function adopt(
	input: ParsedCommand,
	target: EffectiveTarget,
	runtime: ReconcileRuntime,
	stateStore: StateStore,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot
): Promise<ReconcileResult> {
	if (!remote.d1) {
		throw conflict(`adopt requires an existing D1 database matching --d1 ${target.d1}`);
	}
	if (!remote.r2Exists) {
		throw conflict(`adopt requires an existing R2 bucket matching --r2 ${target.r2}`);
	}
	if (!remote.workerExists) {
		throw conflict(`adopt requires an existing Worker matching --worker-name ${target.workerName}`);
	}
	const state = adoptState(input, target, existing, remote, runtime.now());
	await stateStore.save(state);
	return {
		exitCode: 0,
		command: 'adopt',
		provider: 'cloudflare',
		plan: [
			{
				id: 'adopt',
				summary: `record Worker ${target.workerName}, D1 ${remote.d1.name} (${remote.d1.uuid}), R2 ${target.r2}`,
				mutating: true
			}
		],
		mutations: ['state'],
		statePath: stateStore.path,
		missingSecrets: missingSecrets(
			remote.secretNames,
			requiredSecretsFor(target, REQUIRED_WORKER_SECRETS)
		),
		drift: [],
		message:
			'recorded existing Cloudflare resources in local state; no resources were created or deleted',
		bootstrapWarning: bootstrapWarningFor(target),
		migrationPolicy: MIGRATION_POLICY_NOTES
	};
}

async function deployOrUpgrade(
	input: ParsedCommand,
	target: EffectiveTarget,
	runtime: ReconcileRuntime,
	stateStore: StateStore,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot,
	release: ResolvedRelease,
	preparedBundle: PreparedReleaseBundle,
	plan: PlanStep[]
): Promise<ReconcileResult> {
	const mutations: string[] = [];
	const current = { ...remote };
	const initialManagedDeploy = input.command === 'deploy' && existing === undefined;
	assertNoTakeover(input, existing, current);
	assertInitialManagedDeployVars(target, release, initialManagedDeploy);
	if (input.command === 'deploy' && !initialManagedDeploy) {
		assertValidBootstrapOwnerEmail(target.bootstrapOwnerEmail, true);
	}
	if (input.command === 'upgrade') {
		assertUpgradeBootstrapOwnerEmail(target);
	}

	if (input.command === 'upgrade') {
		if (!current.d1 || !current.r2Exists || !current.workerExists) {
			throw conflict(
				'upgrade requires existing Worker, D1, and R2; use deploy to create missing resources or adopt to record them'
			);
		}
	}

	const requiredSecrets = requiredSecretsFor(target, release.manifest.requiredSecrets);
	const missing = missingSecrets(current.secretNames, requiredSecrets);
	const deploymentRecovery = await prepareDeploymentRecovery(
		input,
		target,
		existing,
		current,
		release,
		runtime,
		stateStore.path,
		missing
	);
	if (deploymentRecovery?.created) {
		mutations.push('recovery');
	}

	let workDir: string;
	try {
		if (!current.d1) {
			if (input.command !== 'deploy' || existing) {
				throw conflict(`D1 ${target.d1} does not exist`);
			}
			if (isUuid(target.d1)) {
				throw conflict(
					`D1 id ${target.d1} was not found; pass a D1 name to create it, or adopt an existing database`
				);
			}
			current.d1 = await runtime.wrangler.createD1(target.d1);
			mutations.push('create-d1');
		}
		if (!current.r2Exists) {
			if (input.command !== 'deploy' || existing) {
				throw conflict(`R2 bucket ${target.r2} does not exist`);
			}
			await runtime.wrangler.createR2(target.r2);
			current.r2Exists = true;
			mutations.push('create-r2');
		}

		workDir = await runtime.fs.mkdtemp(join(runtime.fs.tmpdir(), 'create-signkit-'));
	} catch (error) {
		if (deploymentRecovery) {
			await runtime.fs.rm(deploymentRecovery.cleanupDir);
		}
		throw error;
	}
	let backupPath: string | undefined;
	try {
		const extracted = await runtime.extractor.extract(
			preparedBundle.bytes,
			workDir,
			release.manifest
		);
		const generatedVars = generatedWorkerVars(target, initialManagedDeploy);
		assertRequiredVarsPresent(release.manifest.requiredVars, generatedVars, initialManagedDeploy);
		await writeGeneratedConfig(runtime.fs, extracted, target, current, release, generatedVars);

		if (!current.d1) {
			throw generic('D1 id is required before exporting a backup');
		}
		backupPath = await persistD1Backup(runtime, stateStore.path, current.d1.name);
		mutations.push('d1-export');

		const migrationOptions = {
			cwd: extracted.root,
			configPath: extracted.configPath,
			database: current.d1.name
		};
		const migrations = await runtime.wrangler.listMigrations(migrationOptions);
		assertCompatibleSchemaEpoch(existing, release, migrations.applied);
		const pending = [...migrations.pending];
		if (pending.length > 0) {
			await runtime.wrangler.applyMigrations(migrationOptions);
			mutations.push('d1-migrations');
			const remaining = await runtime.wrangler.listMigrations(migrationOptions);
			if (remaining.pending.length > 0) {
				throw generic(`D1 migrations remain pending after apply: ${remaining.pending.join(', ')}`);
			}
		}
		const newlyApplied = pending;
		const appliedMigrations = unionAppliedMigrations(existing?.appliedMigrations, newlyApplied);

		const previousVersionId = existing?.lastWorkerVersionId ?? current.versions[0]?.id;
		const deployOptions = {
			cwd: extracted.root,
			configPath: extracted.configPath,
			workerName: target.workerName,
			domain: target.domain,
			keepVars: true,
			noBundle: true,
			...(deploymentRecovery ? { secretsFile: deploymentRecovery.secretsFile } : {})
		};
		const uploaded = assertSuccessfulUpload(
			input.command === 'upgrade'
				? await runtime.wrangler.uploadVersion(deployOptions)
				: await runtime.wrangler.deploy(deployOptions)
		);
		assertNewWorkerVersion(uploaded.workerVersionId, previousVersionId);
		mutations.push(input.command === 'upgrade' ? 'versions-upload' : 'deploy');
		if (input.command === 'upgrade') {
			await runtime.wrangler.deployVersion(target.workerName, uploaded.workerVersionId);
			mutations.push('versions-deploy');
		}

		const workerUrl = resolveProductionSmokeOrigin(target, uploaded, target.workerName);
		const attachedCustomDomainThisDeploy =
			input.command === 'deploy' && Boolean(deployOptions.domain);
		const fallbackUrl = attachedCustomDomainThisDeploy
			? selectProductionWorkersDevOrigin(uploaded.stdout, target.workerName)
			: undefined;
		let rollback: RollbackReport | undefined;
		if (!workerUrl) {
			rollback = await maybeRollback(
				runtime.wrangler,
				target.workerName,
				previousVersionId,
				'HTTPS smoke check skipped: no production origin is known'
			);
			const state = nextState(input, target, existing, current, release, runtime.now(), {
				lastWorkerVersionId: rollback.performed ? previousVersionId : uploaded.workerVersionId,
				previousWorkerVersionId: previousVersionId,
				appliedMigrations,
				lastD1BackupPath: backupPath
			});
			await stateStore.save(state);
			return {
				exitCode: 1,
				command: input.command,
				provider: 'cloudflare',
				version: release.tag,
				commit: release.commit,
				provenance: preparedBundle.provenance,
				plan,
				mutations,
				statePath: stateStore.path,
				workerUrl: undefined,
				d1BackupPath: backupPath,
				missingSecrets: [],
				drift: [],
				rollback,
				message: `HTTPS smoke check skipped: no production origin is known; refusing to use a version-preview URL as production verification. Pass --public-origin or --domain. ${rollback.guidance}`,
				bootstrapWarning: bootstrapWarningFor(target),
				migrationPolicy: MIGRATION_POLICY_NOTES,
				...recoveryMetadata(deploymentRecovery)
			};
		}
		const smoke = await smokeCheck({
			url: workerUrl,
			fallbackUrl: fallbackUrl && fallbackUrl !== workerUrl ? fallbackUrl : undefined,
			http: runtime.http,
			attempts: runtime.smokeAttempts,
			backoffMs: runtime.smokeBackoffMs,
			timeoutMs: runtime.smokeTimeoutMs,
			sleep: runtime.sleep
		});
		if (!smoke.ok) {
			rollback = await maybeRollback(
				runtime.wrangler,
				target.workerName,
				previousVersionId,
				smoke.detail
			);
			const state = nextState(input, target, existing, current, release, runtime.now(), {
				lastWorkerVersionId: rollback.performed ? previousVersionId : uploaded.workerVersionId,
				previousWorkerVersionId: previousVersionId,
				appliedMigrations,
				lastD1BackupPath: backupPath
			});
			await stateStore.save(state);
			return {
				exitCode: 1,
				command: input.command,
				provider: 'cloudflare',
				version: release.tag,
				commit: release.commit,
				provenance: preparedBundle.provenance,
				plan,
				mutations,
				statePath: stateStore.path,
				workerUrl,
				d1BackupPath: backupPath,
				missingSecrets: [],
				drift: [],
				rollback,
				message: `HTTPS smoke check failed: ${smoke.detail}. ${rollback.guidance}`,
				bootstrapWarning: bootstrapWarningFor(target),
				migrationPolicy: MIGRATION_POLICY_NOTES,
				...recoveryMetadata(deploymentRecovery)
			};
		}

		const state = nextState(input, target, existing, current, release, runtime.now(), {
			lastWorkerVersionId: uploaded.workerVersionId,
			previousWorkerVersionId: previousVersionId,
			appliedMigrations,
			lastD1BackupPath: backupPath
		});
		await stateStore.save(state);
		return {
			exitCode: 0,
			command: input.command,
			provider: 'cloudflare',
			version: release.tag,
			commit: release.commit,
			provenance: preparedBundle.provenance,
			plan,
			mutations,
			statePath: stateStore.path,
			workerUrl,
			d1BackupPath: backupPath,
			missingSecrets: [],
			drift: [],
			message:
				input.command === 'upgrade'
					? `upgraded ${target.workerName} to ${release.tag}`
					: `deployed ${target.workerName} at ${release.tag}`,
			bootstrapWarning: bootstrapWarningFor(target),
			migrationPolicy: MIGRATION_POLICY_NOTES,
			...recoveryMetadata(deploymentRecovery)
		};
	} finally {
		await runtime.fs.rm(workDir);
		if (deploymentRecovery) {
			await runtime.fs.rm(deploymentRecovery.cleanupDir);
		}
	}
}

async function persistD1Backup(
	runtime: ReconcileRuntime,
	statePath: string,
	d1Name: string
): Promise<string> {
	const dir = resolveBackupsDir(statePath);
	await runtime.fs.mkdir(dir, { mode: BACKUP_DIR_MODE });
	await runtime.fs.chmod(dir, BACKUP_DIR_MODE);
	const backupPath = await uniqueD1BackupPath(runtime, dir, d1Name);
	await runtime.wrangler.exportD1(d1Name, backupPath);
	await runtime.fs.chmod(backupPath, BACKUP_FILE_MODE);
	return backupPath;
}

async function uniqueD1BackupPath(
	runtime: ReconcileRuntime,
	dir: string,
	d1Name: string
): Promise<string> {
	const base = d1BackupFileName(d1Name, runtime.now());
	let candidate = join(dir, base);
	let suffix = 2;
	while (await runtime.fs.exists(candidate)) {
		candidate = join(dir, base.replace(/\.sql$/, `-${suffix}.sql`));
		suffix += 1;
	}
	return candidate;
}

async function maybeRollback(
	wrangler: WranglerClient,
	workerName: string,
	previousVersionId: string | undefined,
	smokeDetail: string
): Promise<RollbackReport> {
	const guidanceBase =
		'D1 was not rolled back and cannot be rolled back by rolling back the Worker. Restore SQL with D1 Time Travel if needed. Worker rollback cannot undo applied migrations.';
	if (!previousVersionId) {
		return {
			attempted: false,
			performed: false,
			workerRolledBack: false,
			d1RolledBack: false,
			guidance: `No previous Worker version ID is recorded, so Worker rollback was not performed. ${guidanceBase} Smoke failure: ${smokeDetail}`
		};
	}
	try {
		await wrangler.rollback(
			workerName,
			previousVersionId,
			`${PACKAGE_NAME} smoke check failed; restoring previous Worker version`
		);
		return {
			attempted: true,
			performed: true,
			workerRolledBack: true,
			d1RolledBack: false,
			previousWorkerVersionId: previousVersionId,
			guidance: `Rolled the Worker back to version ${previousVersionId}. ${guidanceBase}`
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			attempted: true,
			performed: false,
			workerRolledBack: false,
			d1RolledBack: false,
			previousWorkerVersionId: previousVersionId,
			guidance: `Worker rollback to ${previousVersionId} was attempted and failed (${detail}). ${guidanceBase}`
		};
	}
}

interface RemoteSnapshot {
	d1?: D1Database;
	r2Exists: boolean;
	workerExists: boolean;
	secretNames: string[];
	versions: WorkerVersion[];
}

async function inspectRemote(
	wrangler: WranglerClient,
	target: EffectiveTarget
): Promise<RemoteSnapshot> {
	const [databases, r2Exists, versions, secretNames] = await Promise.all([
		wrangler.listD1(),
		wrangler.r2Exists(target.r2),
		wrangler.listVersions(target.workerName),
		wrangler.listSecrets(target.workerName)
	]);
	const d1 = databases.find(
		(database) => database.name === target.d1 || database.uuid === target.d1
	);
	return {
		d1,
		r2Exists,
		workerExists: versions.length > 0 || secretNames.length > 0,
		secretNames,
		versions: sortWorkerVersions(versions)
	};
}

function detectDrift(
	existing: DeploymentState | undefined,
	target: EffectiveTarget,
	remote: RemoteSnapshot
): string[] {
	if (!existing) {
		return [];
	}
	const drift: string[] = [];
	if (existing.accountId !== target.accountId) {
		drift.push('account-id mismatch');
	}
	if (existing.workerName !== target.workerName) {
		drift.push(`worker-name local=${existing.workerName} requested=${target.workerName}`);
	}
	if (existing.d1.name !== target.d1 && existing.d1.id !== target.d1) {
		drift.push(`d1 local=${existing.d1.name}/${existing.d1.id} requested=${target.d1}`);
	}
	if (existing.r2.name !== target.r2) {
		drift.push(`r2 local=${existing.r2.name} requested=${target.r2}`);
	}
	if (remote.d1 && existing.d1.id && existing.d1.id !== remote.d1.uuid) {
		drift.push(`d1 id local=${existing.d1.id} remote=${remote.d1.uuid}`);
	}
	if (!remote.d1) {
		drift.push(`d1 ${existing.d1.name} is missing remotely`);
	}
	if (!remote.r2Exists) {
		drift.push(`r2 ${existing.r2.name} is missing remotely`);
	}
	if (remote.workerExists === false) {
		drift.push(`worker ${existing.workerName} is missing remotely`);
	}
	return drift;
}

function buildPlan(
	input: ParsedCommand,
	existing: DeploymentState | undefined,
	target: EffectiveTarget,
	remote: RemoteSnapshot,
	release: ResolvedRelease
): PlanStep[] {
	const steps: PlanStep[] = [
		{
			id: 'resolve-version',
			summary: `use GitHub release ${release.tag} (${release.commit ?? 'commit unknown'})`,
			mutating: false
		},
		{
			id: 'validate-manifest',
			summary: `validate ${release.manifest.bundle.assetName} size ${release.manifest.bundle.size} sha256 ${release.manifest.bundle.sha256}`,
			mutating: false
		},
		{
			id: 'verify-provenance',
			summary: `verify GitHub/Sigstore provenance for ${release.manifest.bundle.assetName}`,
			mutating: false
		}
	];
	if (input.command === 'adopt') {
		return [
			{
				id: 'adopt',
				summary: `record Worker ${target.workerName}, D1 ${target.d1}, R2 ${target.r2} in local state`,
				mutating: true
			}
		];
	}
	if (!remote.d1 && !existing) {
		steps.push({
			id: 'create-d1',
			summary: `create D1 ${d1Name(target, remote)}`,
			mutating: true
		});
	}
	if (!remote.r2Exists && !existing) {
		steps.push({ id: 'create-r2', summary: `create R2 ${target.r2}`, mutating: true });
	}
	steps.push({
		id: 'd1-export',
		summary: `export D1 ${target.d1} to a retained local backup`,
		mutating: true
	});
	steps.push({
		id: 'd1-migrations',
		summary: 'apply pending D1 migrations only',
		mutating: true
	});
	steps.push({
		id: input.command === 'upgrade' ? 'versions-upload' : 'deploy',
		summary:
			input.command === 'upgrade'
				? `upload Worker version for ${target.workerName} with --keep-vars`
				: `deploy Worker ${target.workerName} with --keep-vars`,
		mutating: true
	});
	steps.push({
		id: 'smoke',
		summary: `HTTPS smoke check ${target.publicOrigin ?? 'workers.dev URL'}/api/v1/system/capabilities`,
		mutating: false
	});
	steps.push({
		id: 'state',
		summary: `write local state at the configured path (no secrets)`,
		mutating: true
	});
	return steps;
}

function nextState(
	input: ParsedCommand,
	target: EffectiveTarget,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot,
	release: ResolvedRelease,
	now: Date,
	extra: Partial<DeploymentState>
): DeploymentState {
	if (!remote.d1) {
		throw generic('cannot write state without a D1 id');
	}
	return {
		schemaVersion: 1,
		provider: 'cloudflare',
		accountId: target.accountId,
		workerName: target.workerName,
		d1: { name: remote.d1.name, id: remote.d1.uuid },
		r2: { name: target.r2 },
		domain: target.domain ?? existing?.domain,
		publicOrigin: target.publicOrigin ?? existing?.publicOrigin,
		d6eAuthBaseUrl: target.d6eAuthBaseUrl,
		emailFrom: target.emailFrom ?? existing?.emailFrom,
		emailFromName: target.emailFromName,
		mailProvider: target.mailProvider,
		...(target.mailProvider === 'smtp'
			? {
					smtpHost: target.smtpHost,
					smtpPort: target.smtpPort,
					smtpSecure: target.smtpSecure,
					smtpUsername: target.smtpUsername
				}
			: {}),
		bootstrapOwnerEmail: target.bootstrapOwnerEmail ?? existing?.bootstrapOwnerEmail,
		lastD1BackupPath: extra.lastD1BackupPath ?? existing?.lastD1BackupPath,
		channel: input.channel,
		version: release.tag,
		commit: release.commit,
		schemaEpoch: release.manifest.migrationPolicy.schemaEpoch,
		lastCommand: input.command,
		updatedAt: now.toISOString(),
		lastWorkerVersionId: extra.lastWorkerVersionId ?? existing?.lastWorkerVersionId,
		previousWorkerVersionId: extra.previousWorkerVersionId ?? existing?.previousWorkerVersionId,
		appliedMigrations: extra.appliedMigrations ?? existing?.appliedMigrations,
		adopted: extra.adopted ?? existing?.adopted
	};
}

function generatedWorkerVars(
	target: EffectiveTarget,
	initialManagedDeploy: boolean
): Record<string, string> {
	const vars: Record<string, string> = {
		SIGNKIT_MAIL_PROVIDER: target.mailProvider
	};
	if (target.mailProvider === 'smtp') {
		if (target.smtpHost) vars.SIGNKIT_SMTP_HOST = target.smtpHost;
		if (target.smtpPort !== undefined) vars.SIGNKIT_SMTP_PORT = String(target.smtpPort);
		if (target.smtpSecure !== undefined) vars.SIGNKIT_SMTP_SECURE = String(target.smtpSecure);
		if (target.smtpUsername) vars.SIGNKIT_SMTP_USERNAME = target.smtpUsername;
	}
	if (target.publicOrigin) {
		vars.SIGNKIT_PUBLIC_ORIGIN = target.publicOrigin;
	}
	if (initialManagedDeploy || !target.appliedDefaults.d6eAuthBaseUrl) {
		vars.D6E_AUTH_BASE_URL = target.d6eAuthBaseUrl;
	}
	if (target.emailFrom) {
		vars.SIGNKIT_EMAIL_FROM = target.emailFrom;
	}
	if (initialManagedDeploy || !target.appliedDefaults.emailFromName) {
		vars.SIGNKIT_EMAIL_FROM_NAME = target.emailFromName;
	}
	if (target.bootstrapOwnerEmail) {
		vars.SIGNKIT_BOOTSTRAP_OWNER_EMAIL = target.bootstrapOwnerEmail;
	}
	return vars;
}

function assertInitialManagedDeployVars(
	target: EffectiveTarget,
	release: ResolvedRelease,
	initialManagedDeploy: boolean
): void {
	if (!initialManagedDeploy) {
		return;
	}
	if (!target.emailFrom) {
		throw preflight(
			'--email-from is required for the initial managed deploy (SIGNKIT_EMAIL_FROM). Secrets are never accepted on argv.'
		);
	}
	if (!target.publicOrigin) {
		throw preflight(
			'--public-origin or --domain is required for the initial managed deploy (SIGNKIT_PUBLIC_ORIGIN)'
		);
	}
	assertValidBootstrapOwnerEmail(target.bootstrapOwnerEmail, false);
	assertRequiredVarsPresent(release.manifest.requiredVars, generatedWorkerVars(target, true), true);
}

/**
 * A fresh uninitialized deployment must not be claimable without a bootstrap
 * owner: deploy and upgrade both require the effective
 * `--bootstrap-owner-email` (explicit flag or inherited state). State files
 * written before this requirement stay loadable — the field is optional in
 * the schema — but upgrading or redeploying with one requires passing the
 * flag once, after which the value is recorded in state and inherited.
 * Already-bootstrapped instances are unaffected by the value itself since
 * bootstrap never runs again. Errors name the flag, never the address.
 */
function assertUpgradeBootstrapOwnerEmail(target: EffectiveTarget): void {
	assertValidBootstrapOwnerEmail(target.bootstrapOwnerEmail, true);
}

function assertValidBootstrapOwnerEmail(value: string | undefined, hasState: boolean): void {
	if (value === undefined || !isValidEmailAddress(value)) {
		throw preflight(
			hasState
				? '--bootstrap-owner-email is required for deploy/upgrade (SIGNKIT_BOOTSTRAP_OWNER_EMAIL): no valid address is recorded in state, so pass the flag once to record it'
				: '--bootstrap-owner-email is required for the initial managed deploy (SIGNKIT_BOOTSTRAP_OWNER_EMAIL): an uninitialized instance fails closed without it. Secrets are never accepted on argv.'
		);
	}
}

function assertRequiredVarsPresent(
	required: readonly string[],
	generated: Record<string, string>,
	initialManagedDeploy: boolean
): void {
	if (!initialManagedDeploy) {
		return;
	}
	const missing = required.filter((name) => !generated[name]);
	if (missing.length > 0) {
		throw preflight(
			`generated initial-managed-deploy Worker config is missing required vars: ${missing.join(', ')}`
		);
	}
}

function assertCloudflareState(existing: DeploymentState | undefined): void {
	if (existing && existing.provider !== 'cloudflare') {
		throw conflict('deployment state provider is not cloudflare; refusing to inherit or mutate it');
	}
}

function adoptState(
	input: ParsedCommand,
	target: EffectiveTarget,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot,
	now: Date
): DeploymentState {
	if (!remote.d1) {
		throw generic('cannot write state without a D1 id');
	}
	const retarget =
		existing !== undefined &&
		(existing.workerName !== target.workerName ||
			existing.d1.id !== remote.d1.uuid ||
			existing.d1.name !== remote.d1.name ||
			existing.r2.name !== target.r2);
	return {
		schemaVersion: 1,
		provider: 'cloudflare',
		accountId: target.accountId,
		workerName: target.workerName,
		d1: { name: remote.d1.name, id: remote.d1.uuid },
		r2: { name: target.r2 },
		domain: target.domain ?? existing?.domain,
		publicOrigin: target.publicOrigin ?? existing?.publicOrigin,
		d6eAuthBaseUrl: target.d6eAuthBaseUrl,
		emailFrom: target.emailFrom ?? existing?.emailFrom,
		emailFromName: target.emailFromName,
		mailProvider: target.mailProvider,
		...(target.mailProvider === 'smtp'
			? {
					smtpHost: target.smtpHost,
					smtpPort: target.smtpPort,
					smtpSecure: target.smtpSecure,
					smtpUsername: target.smtpUsername
				}
			: {}),
		bootstrapOwnerEmail: target.bootstrapOwnerEmail ?? existing?.bootstrapOwnerEmail,
		lastD1BackupPath: retarget ? undefined : existing?.lastD1BackupPath,
		channel: input.channel,
		version: retarget ? undefined : existing?.version,
		commit: retarget ? undefined : existing?.commit,
		schemaEpoch: retarget ? undefined : existing?.schemaEpoch,
		lastCommand: 'adopt',
		updatedAt: now.toISOString(),
		lastWorkerVersionId: retarget ? undefined : existing?.lastWorkerVersionId,
		previousWorkerVersionId: retarget ? undefined : existing?.previousWorkerVersionId,
		appliedMigrations: retarget ? undefined : existing?.appliedMigrations,
		adopted: true
	};
}

function assertCompatibleSchemaEpoch(
	existing: DeploymentState | undefined,
	release: ResolvedRelease,
	appliedMigrations: readonly string[]
): void {
	const releaseEpoch = release.manifest.migrationPolicy.schemaEpoch;
	if (!existing || existing.schemaEpoch === releaseEpoch || appliedMigrations.length === 0) {
		return;
	}
	const recorded = existing.schemaEpoch ?? 'unrecorded legacy schema';
	throw conflict(
		`D1 schema epoch ${recorded} cannot be upgraded in place to ${releaseEpoch}. Recreate the selected D1, adopt the fresh database, and run deploy again.`
	);
}

function assertNoTakeover(
	input: ParsedCommand,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot
): void {
	if (existing) {
		return;
	}
	if (input.command === 'deploy' && remote.versions.length > 0) {
		throw conflict(
			'this Worker already has published versions; adopt the existing deployment before deploy rather than taking it over'
		);
	}
	if (input.command === 'deploy' && remote.secretNames.length > 0) {
		throw conflict(
			'this Worker already has stored secrets; adopt the existing deployment before deploy rather than taking it over'
		);
	}
}

interface DeploymentRecovery {
	secretsFile: string;
	cleanupDir: string;
	recoveryPath: string;
	recoveryFingerprint: string;
	created: boolean;
}

function recoveryMetadata(
	recovery: DeploymentRecovery | undefined
): Pick<ReconcileResult, 'recoveryPath' | 'recoveryFingerprint'> {
	if (!recovery) {
		return {};
	}
	return {
		recoveryPath: recovery.recoveryPath,
		recoveryFingerprint: recovery.recoveryFingerprint
	};
}

function isPristineInitialDeploy(
	input: ParsedCommand,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot
): boolean {
	return (
		input.command === 'deploy' &&
		existing === undefined &&
		remote.versions.length === 0 &&
		remote.secretNames.length === 0
	);
}

function assertSupportedSecretTaxonomy(
	release: ResolvedRelease,
	runtime: ReconcileRuntime,
	statePath: string
): void {
	try {
		assertExactRequiredSecrets(release.manifest.requiredSecrets);
	} catch (error) {
		const recoveryPath = runtime.recoveryPath ?? resolveRecoveryPath(statePath);
		throw preflight(
			`${error instanceof Error ? error.message : String(error)}. Restore the recovery file at ${recoveryPath} from a secure backup; the CLI never accepts unknown secret types.`
		);
	}
}

async function prepareDeploymentRecovery(
	input: ParsedCommand,
	target: EffectiveTarget,
	existing: DeploymentState | undefined,
	remote: RemoteSnapshot,
	release: ResolvedRelease,
	runtime: ReconcileRuntime,
	statePath: string,
	missingSecrets: readonly string[]
): Promise<DeploymentRecovery | undefined> {
	const pristine = isPristineInitialDeploy(input, existing, remote);
	if (!pristine && missingSecrets.length === 0) {
		return undefined;
	}
	const recoveryPath = runtime.recoveryPath ?? resolveRecoveryPath(statePath);
	const recoveryExists: boolean = await runtime.fs.exists(recoveryPath);
	if (!recoveryExists && !pristine) {
		throw preflight(
			`missing required Worker secrets: ${missingSecrets.join(', ')}. Restore the flat recovery JSON at ${recoveryPath}; create-signkit will validate it and pass it to Wrangler with --secrets-file on the next deploy or upgrade. Secret values are never accepted on argv, and the CLI never generates or overwrites recovery secrets for an existing deployment.`
		);
	}
	if (recoveryExists) {
		try {
			await ensureRecoveryBinding({
				fs: runtime.fs,
				recoveryPath,
				accountId: target.accountId,
				workerName: target.workerName,
				allowCreate: false
			});
			const requiredSecrets = pristine
				? requiredSecretsFor(target, release.manifest.requiredSecrets)
				: missingSecrets;
			const reused = await tryReuseRecoverySecrets({
				fs: runtime.fs,
				recoveryPath,
				requiredSecrets
			});
			if (!reused) {
				throw new Error(`recovery file at ${recoveryPath} disappeared during validation`);
			}
			return stageDeploymentRecovery(runtime, reused, requiredSecrets);
		} catch (error) {
			throw preflight(
				`${error instanceof Error ? error.message : String(error)}. Restore the recovery file and its binding metadata at ${recoveryPath} from a secure backup; the CLI never overwrites them and identifies the secret map by path and SHA-256 fingerprint only.`
			);
		}
	}
	if (!runtime.readStdin) {
		throw preflight(
			`Secret stdin is unavailable for the initial deploy at ${recoveryPath}. Provide the required secrets once via stdin redirection from a secure JSON file. Secrets are never accepted on argv and are never printed.`
		);
	}
	const requiresSmtpPassword: boolean =
		target.mailProvider === 'smtp' && target.smtpUsername !== undefined;
	let initialSecrets: InitialSecretInput;
	try {
		initialSecrets = await readInitialSecrets(runtime.readStdin, requiresSmtpPassword);
	} catch (error) {
		throw preflight(
			`${error instanceof Error ? error.message : String(error)}. Provide the initial secrets once via stdin redirection from a secure JSON file containing D6E_AUTH_CLIENT_ID and D6E_AUTH_CLIENT_SECRET${requiresSmtpPassword ? ` plus ${SMTP_PASSWORD_SECRET}` : ''}. Secrets are never accepted on argv and are never printed.`
		);
	}
	try {
		await ensureRecoveryBinding({
			fs: runtime.fs,
			recoveryPath,
			accountId: target.accountId,
			workerName: target.workerName,
			allowCreate: true
		});
		const requiredSecrets = requiredSecretsFor(target, release.manifest.requiredSecrets);
		const ensured = await ensureRecoverySecrets({
			fs: runtime.fs,
			recoveryPath,
			requiredSecrets,
			oauth: {
				D6E_AUTH_CLIENT_ID: initialSecrets.D6E_AUTH_CLIENT_ID,
				D6E_AUTH_CLIENT_SECRET: initialSecrets.D6E_AUTH_CLIENT_SECRET
			},
			...(initialSecrets.SIGNKIT_SMTP_PASSWORD
				? { smtpPassword: initialSecrets.SIGNKIT_SMTP_PASSWORD }
				: {}),
			...(runtime.randomBytes ? { randomBytes: runtime.randomBytes } : {})
		});
		return stageDeploymentRecovery(runtime, ensured, requiredSecrets);
	} catch (error) {
		throw preflight(
			`${error instanceof Error ? error.message : String(error)}. Restore the recovery file at ${recoveryPath} from a secure backup; the CLI never overwrites it and identifies it by path and SHA-256 fingerprint only.`
		);
	}
}

async function stageDeploymentRecovery(
	runtime: ReconcileRuntime,
	recovery: { path: string; fingerprint: string; created: boolean },
	secretNames: readonly string[]
): Promise<DeploymentRecovery> {
	const cleanupDir: string = await runtime.fs.mkdtemp(
		join(runtime.fs.tmpdir(), 'create-signkit-secrets-')
	);
	try {
		await runtime.fs.chmod(cleanupDir, RECOVERY_DIR_MODE);
		const secretsFile: string = await stageRecoverySecrets({
			fs: runtime.fs,
			recoveryPath: recovery.path,
			outputPath: join(cleanupDir, 'secrets.json'),
			secretNames,
			expectedFingerprint: recovery.fingerprint
		});
		return {
			secretsFile,
			cleanupDir,
			recoveryPath: recovery.path,
			recoveryFingerprint: recovery.fingerprint,
			created: recovery.created
		};
	} catch (error) {
		await runtime.fs.rm(cleanupDir);
		throw error;
	}
}

function resolveProductionSmokeOrigin(
	target: EffectiveTarget,
	uploaded: { workerUrl?: string; stdout: string },
	workerName: string
): string | undefined {
	if (target.publicOrigin) {
		return target.publicOrigin;
	}
	return (
		selectProductionWorkersDevOrigin(uploaded.stdout, workerName) ??
		(uploaded.workerUrl
			? selectProductionWorkersDevOrigin(uploaded.workerUrl, workerName)
			: undefined)
	);
}

function assertUpgradeRouteUnchanged(
	input: ParsedCommand,
	existing: DeploymentState | undefined
): void {
	if (input.command !== 'upgrade' || !existing) {
		return;
	}
	if (input.overrides.domain && (input.domain ?? '') !== (existing.domain ?? '')) {
		throw conflict(
			'upgrade refuses an explicit --domain that differs from stored state; use deploy or adopt to change routing'
		);
	}
	if (
		input.overrides.publicOrigin &&
		(input.publicOrigin ?? '') !== (existing.publicOrigin ?? '')
	) {
		throw conflict(
			'upgrade refuses an explicit --public-origin that differs from stored state; use deploy or adopt to change routing'
		);
	}
}

function assertNewWorkerVersion(
	workerVersionId: string | undefined,
	previousVersionId: string | undefined
): asserts workerVersionId is string {
	if (!workerVersionId) {
		throw generic(
			'Wrangler did not report a labelled Worker Version ID; refusing to treat another UUID as the Worker version'
		);
	}
	if (previousVersionId && workerVersionId === previousVersionId) {
		throw generic(
			'Wrangler reported the same Worker Version ID as the previous version; refusing to treat this as a successful upload'
		);
	}
}

function unionAppliedMigrations(existing: string[] | undefined, newlyApplied: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of [...(existing ?? []), ...newlyApplied]) {
		if (seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

function missingSecrets(present: string[], required: readonly string[]): string[] {
	const have = new Set(present);
	return required.filter((name) => !have.has(name));
}

function requiredSecretsFor(target: EffectiveTarget, names: readonly string[]): string[] {
	return [
		...new Set([
			...REQUIRED_WORKER_SECRETS,
			...names,
			...(target.mailProvider === 'smtp' && target.smtpUsername ? [SMTP_PASSWORD_SECRET] : [])
		])
	];
}

function d1Name(target: EffectiveTarget, remote: RemoteSnapshot): string {
	return remote.d1?.name ?? (isUuid(target.d1) ? target.d1 : target.d1);
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function posixPath(root: string, absolute: string, label: string): string {
	try {
		return posixRelativeToRoot(root, absolute, label);
	} catch (error) {
		throw generic(error instanceof Error ? error.message : String(error));
	}
}

function resolvePath(runtime: ReconcileRuntime, input: ParsedCommand): string {
	return resolveStatePath(runtime.fs, runtime.env, input.statePath);
}

async function writeGeneratedConfig(
	fs: FileSystem,
	extracted: ExtractedBundle,
	target: EffectiveTarget,
	remote: RemoteSnapshot,
	release: ResolvedRelease,
	vars: Record<string, string>
): Promise<void> {
	if (!remote.d1) {
		throw generic('D1 id is required before generating wrangler.jsonc');
	}
	const contents = renderWranglerConfig({
		workerName: target.workerName,
		d1Name: remote.d1.name,
		d1Id: remote.d1.uuid,
		r2Name: target.r2,
		domain: target.domain,
		publicOrigin: vars.SIGNKIT_PUBLIC_ORIGIN,
		d6eAuthBaseUrl: vars.D6E_AUTH_BASE_URL,
		emailFrom: vars.SIGNKIT_EMAIL_FROM,
		emailFromName: vars.SIGNKIT_EMAIL_FROM_NAME,
		mailProvider: target.mailProvider,
		smtpHost: vars.SIGNKIT_SMTP_HOST,
		smtpPort: vars.SIGNKIT_SMTP_PORT ? Number(vars.SIGNKIT_SMTP_PORT) : undefined,
		smtpSecure:
			vars.SIGNKIT_SMTP_SECURE === undefined ? undefined : vars.SIGNKIT_SMTP_SECURE === 'true',
		smtpUsername: vars.SIGNKIT_SMTP_USERNAME,
		bootstrapOwnerEmail: vars.SIGNKIT_BOOTSTRAP_OWNER_EMAIL,
		manifest: release.manifest,
		main: posixPath(extracted.root, extracted.main, 'generated Worker main'),
		assetsDirectory: posixPath(
			extracted.root,
			extracted.assetsDirectory,
			'generated assets directory'
		),
		migrationsDirectory: posixPath(
			extracted.root,
			extracted.migrationsDirectory,
			'generated migrations directory'
		)
	});
	await fs.writeFile(extracted.configPath, contents);
}
