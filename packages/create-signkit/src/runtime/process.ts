import { spawn } from 'node:child_process';
import { MAX_WRANGLER_OUTPUT_BYTES, SECRET_ENV_NAME } from '../constants.js';

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunCommandRequest {
	file: string;
	argv: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface ProcessRunner {
	run(request: RunCommandRequest): Promise<CommandResult>;
}

export interface ProcessRunnerOptions {
	maxOutputBytes?: number;
}

const ALLOWED_WRANGLER_ENV = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMDATA',
	'SystemRoot',
	'SYSTEMROOT',
	'windir',
	'WINDIR',
	'TMPDIR',
	'TEMP',
	'TMP',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LC_MESSAGES',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'ALL_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'all_proxy',
	'XDG_CONFIG_HOME',
	'XDG_CACHE_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_RUNTIME_DIR',
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_API_KEY',
	'CLOUDFLARE_EMAIL',
	'WRANGLER_LOG',
	'WRANGLER_SEND_METRICS',
	'CI'
]);

export function createNodeProcessRunner(options: ProcessRunnerOptions = {}): ProcessRunner {
	const maxOutputBytes = options.maxOutputBytes ?? MAX_WRANGLER_OUTPUT_BYTES;
	return {
		run(request) {
			return runChild(request, maxOutputBytes);
		}
	};
}

export function assertArgvHasNoSecrets(argv: readonly string[]): void {
	for (const [index, token] of argv.entries()) {
		const lower = token.toLowerCase();
		if (lower.startsWith('--') && SECRET_ENV_NAME.test(lower.slice(2))) {
			throw new Error(`refusing to invoke a process with secret-bearing argv flag ${token}`);
		}
		if (index > 0 && isPathFlag(argv[index - 1])) {
			continue;
		}
		if (index > 0 && looksLikeSecretValue(token)) {
			throw new Error('refusing to invoke a process with a secret-like argv value');
		}
	}
}

const PATH_FLAGS = new Set(['--config', '--secrets-file']);

function isPathFlag(token: string | undefined): boolean {
	return token !== undefined && PATH_FLAGS.has(token.toLowerCase());
}

export function filterEnvForWrangler(
	source: NodeJS.ProcessEnv,
	accountId: string
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (ALLOWED_WRANGLER_ENV.has(key)) {
			env[key] = value;
		}
	}
	env.CLOUDFLARE_ACCOUNT_ID = accountId;
	env.CI = '1';
	return env;
}

export function envHasSecretName(name: string): boolean {
	return SECRET_ENV_NAME.test(name);
}

function looksLikeSecretValue(token: string): boolean {
	if (token.startsWith('sk-') || token.startsWith('signkit_') || token.startsWith('AKIA')) {
		return true;
	}
	return token.includes('-----BEGIN');
}

function runChild(request: RunCommandRequest, maxOutputBytes: number): Promise<CommandResult> {
	assertArgvHasNoSecrets([request.file, ...request.argv]);
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (action: () => void) => {
			if (settled) return;
			settled = true;
			action();
		};
		const child = spawn(request.file, request.argv, {
			cwd: request.cwd,
			env: request.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let overLimit = false;

		child.stdout?.on('data', (chunk: Buffer) => {
			if (settled || overLimit) return;
			stdoutBytes += chunk.length;
			if (stdoutBytes > maxOutputBytes) {
				overLimit = true;
				child.kill();
				settle(() => reject(new Error('process stdout exceeded size limit')));
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			if (settled || overLimit) return;
			stderrBytes += chunk.length;
			if (stderrBytes > maxOutputBytes) {
				overLimit = true;
				child.kill();
				settle(() => reject(new Error('process stderr exceeded size limit')));
				return;
			}
			stderrChunks.push(chunk);
		});
		child.on('error', (error) => {
			settle(() => reject(error));
		});
		child.on('close', (code) => {
			settle(() =>
				resolve({
					code: code ?? 1,
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8')
				})
			);
		});
	});
}
