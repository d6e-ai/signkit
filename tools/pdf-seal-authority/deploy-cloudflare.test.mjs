import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';
import { deploySealAuthority } from './deploy-cloudflare.mjs';

const roles = ['issuer', 'engine', 'validator', 'gateway'];
const manifest = {
	accountId: '0'.repeat(32),
	settings: {
		SEAL_WORKER_PREFIX: 'test-seal',
		SEAL_KEY_BACKEND: 'vercel-kms',
		SEAL_ISSUER: 'issuer',
		SEAL_AUDIENCE: 'instance',
		SEAL_CERTIFICATE_SHA256: 'a'.repeat(64),
		SEAL_POLICY_ID: 'b-b',
		VALIDATION_POLICY_ID: 'b-b-validation',
		SEAL_AUTHORIZATION_PUBLIC_KEY: 'A'.repeat(87),
		SEAL_EVIDENCE_DB_ID: '00000000-0000-4000-8000-000000000001',
		SEAL_EVIDENCE_BUCKET: 'evidence',
		SEAL_LEDGER_DB_ID: '00000000-0000-4000-8000-000000000002',
		SEAL_RESULT_BUCKET: 'results'
	},
	deploy: Object.fromEntries(
		roles.map((role) => [role, { tokenEnv: `DEPLOY_${role.toUpperCase()}` }])
	)
};

test('all local previews finish before cloud deploys, with only the selected role credential', async () => {
	const source = {
		...Object.fromEntries(
			roles.map((role) => [`DEPLOY_${role.toUpperCase()}`, `token-for-${role}`])
		),
		CLOUDFLARE_API_TOKEN: 'unscoped',
		ISSUER_PRIVATE_KEY_PKCS8: 'private'
	};
	const operations = [];
	await deploySealAuthority(manifest, {
		apply: true,
		source,
		runCommand: async (args, { cwd, env }) => {
			assert.equal(env.ISSUER_PRIVATE_KEY_PKCS8, undefined);
			assert.ok(Object.keys(env).every((name) => !name.startsWith('DEPLOY_')));
			if (basename(args[0]) === 'build-cloudflare.mjs') {
				assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
				assert.equal(env.SEAL_KEY_BACKEND, 'vercel-kms');
				operations.push(`build:${env.SEAL_WORKER_ROLE}`);
				return;
			}
			assert.ok(args.includes('--no-provision'));
			assert.ok(args.includes('--prebuilt'));
			assert.equal(env.CLOUDFLARE_ACCOUNT_ID, manifest.accountId);
			const role = basename(cwd);
			if (args.includes('--dry-run')) {
				assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
				operations.push(`preview:${role}`);
			} else {
				assert.equal(env.CLOUDFLARE_API_TOKEN, `token-for-${role}`);
				operations.push(`deploy:${role}`);
			}
		}
	});
	assert.deepEqual(operations, [
		...roles.flatMap((role) => [`build:${role}`, `preview:${role}`]),
		...roles.map((role) => `deploy:${role}`)
	]);
});

test('preview needs no credentials and does not deploy', async () => {
	let previews = 0;
	await deploySealAuthority(manifest, {
		source: {},
		runCommand: async (args) => {
			if (args[1] === 'deploy') {
				assert.ok(args.includes('--dry-run'));
				previews += 1;
			}
		}
	});
	assert.equal(previews, roles.length);
});

test('a failed preview never applies a partial release', async () => {
	const source = Object.fromEntries(roles.map((role) => [`DEPLOY_${role.toUpperCase()}`, role]));
	await assert.rejects(
		deploySealAuthority(manifest, {
			apply: true,
			source,
			runCommand: async (args, { cwd }) => {
				if (args[1] !== 'deploy') return;
				assert.ok(args.includes('--dry-run'));
				if (basename(cwd) === 'gateway') throw new Error('preview rejected');
			}
		}),
		/preview rejected/
	);
});
