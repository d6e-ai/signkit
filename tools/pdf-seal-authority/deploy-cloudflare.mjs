import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildEnvironment } from '../../scripts/build-cloudflare-output.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const require = createRequire(import.meta.url);
const cf = join(dirname(require.resolve('cf/package.json')), 'bin/cf');
const roles = ['issuer', 'engine', 'validator', 'gateway'];
const accountId = z.string().regex(/^[a-f0-9]{32}$/);
const identifier = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const target = z
	.strictObject({
		profile: z
			.string()
			.regex(/^[\w.-]+$/)
			.optional(),
		tokenEnv: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]*$/)
			.optional(),
		secretsFile: identifier.optional()
	})
	.refine(({ profile, tokenEnv }) => Boolean(profile) !== Boolean(tokenEnv), {
		message: 'Specify exactly one profile or tokenEnv'
	});
const releaseSchema = z
	.strictObject({
		accountId,
		settings: z.strictObject({
			SEAL_WORKER_PREFIX: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
			SEAL_KEY_BACKEND: z.enum(['aws-kms', 'vercel-kms', 'pkcs11-hsm']),
			SEAL_ISSUER: identifier,
			SEAL_AUDIENCE: identifier,
			SEAL_CERTIFICATE_SHA256: sha256,
			SEAL_POLICY_ID: identifier,
			VALIDATION_POLICY_ID: identifier,
			SEAL_AUTHORIZATION_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
			SEAL_EVIDENCE_DB_ID: z.uuid(),
			SEAL_EVIDENCE_BUCKET: identifier,
			SEAL_LEDGER_DB_ID: z.uuid(),
			SEAL_RESULT_BUCKET: identifier
		}),
		deploy: z.strictObject({
			issuer: target,
			engine: target,
			validator: target.safeExtend({ accountId: accountId.optional() }),
			gateway: target
		})
	})
	.refine(
		({ settings }) =>
			settings.SEAL_EVIDENCE_DB_ID !== settings.SEAL_LEDGER_DB_ID &&
			settings.SEAL_EVIDENCE_BUCKET !== settings.SEAL_RESULT_BUCKET,
		{
			message: 'The key-service ledger and result bucket must be separate from the evidence stores',
			path: ['settings']
		}
	);

function run(args, options) {
	return new Promise((done, fail) => {
		const child = spawn(process.execPath, args, { ...options, stdio: 'inherit' });
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`Command exited ${signal ?? code}`));
		});
	});
}

function deployEnvironment(source, privateDir, account, target) {
	const env = buildEnvironment(source, privateDir);
	env.CLOUDFLARE_ACCOUNT_ID = account;
	for (const key of ['DOCKER_CONFIG', 'DOCKER_HOST']) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	if (target.tokenEnv) {
		const token = source[target.tokenEnv];
		if (token) env.CLOUDFLARE_API_TOKEN = token;
	} else {
		for (const key of [
			'XDG_CONFIG_HOME',
			'XDG_DATA_HOME',
			'XDG_RUNTIME_DIR',
			'DBUS_SESSION_BUS_ADDRESS',
			'CLOUDFLARE_AUTH_USE_KEYRING'
		]) {
			if (source[key] === undefined) delete env[key];
			else env[key] = source[key];
		}
	}
	return env;
}

export async function deploySealAuthority(
	manifest,
	{ apply = false, source = process.env, runCommand = run, base = process.cwd() } = {}
) {
	const release = releaseSchema.parse(manifest);
	for (const role of roles) {
		const { tokenEnv, secretsFile } = release.deploy[role];
		if (apply && tokenEnv && !source[tokenEnv]) throw new Error(`Missing ${role} deployment token`);
		if (apply && secretsFile) await access(resolve(base, secretsFile));
	}

	const temporary = await mkdtemp(join(tmpdir(), 'signkit-seal-release-'));
	try {
		const buildEnv = buildEnvironment(source, temporary);
		for (const role of roles) {
			const output = join(temporary, role);
			process.stdout.write(`Building and validating ${role}\n`);
			await runCommand([join(directory, 'build-cloudflare.mjs'), output], {
				cwd: root,
				env: { ...buildEnv, ...release.settings, SEAL_WORKER_ROLE: role }
			});
			await runCommand([cf, 'deploy', '--prebuilt', '--no-provision', '--dry-run'], {
				cwd: output,
				env: {
					...buildEnv,
					CLOUDFLARE_ACCOUNT_ID: release.deploy[role].accountId ?? release.accountId
				}
			});
		}
		if (!apply) return;
		for (const role of roles) {
			const target = release.deploy[role];
			const output = join(temporary, role);
			const args = [cf, 'deploy', '--prebuilt', '--no-provision'];
			if (target.profile) args.push('--profile', target.profile);
			if (target.secretsFile) args.push('--secrets-file', resolve(base, target.secretsFile));
			process.stdout.write(`Deploying ${role}\n`);
			await runCommand(args, {
				cwd: output,
				env: deployEnvironment(source, temporary, target.accountId ?? release.accountId, target)
			});
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	try {
		const { values, positionals } = parseArgs({
			options: { apply: { type: 'boolean' } },
			allowPositionals: true
		});
		if (positionals.length !== 1) {
			throw new Error(
				'Usage: node tools/pdf-seal-authority/deploy-cloudflare.mjs <release.json> [--apply]'
			);
		}
		const path = resolve(positionals[0]);
		await deploySealAuthority(JSON.parse(await readFile(path, 'utf8')), {
			apply: values.apply,
			base: dirname(path)
		});
	} catch (error) {
		if (error instanceof z.ZodError) {
			for (const issue of error.issues) console.error(issue.path.join('.'), issue.message);
		} else {
			console.error(error.message);
		}
		process.exitCode = 1;
	}
}
