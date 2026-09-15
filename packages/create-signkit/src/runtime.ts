import type { ParsedCommand } from './cli/parse.js';
import { createFetchHttpClient, type HttpClient } from './runtime/http.js';
import { createNodeFileSystem, type FileSystem } from './runtime/fs.js';
import { createNodeProcessRunner, type ProcessRunner } from './runtime/process.js';
import { createGithubReleaseResolver, type ReleaseResolver } from './release/github.js';
import { createTarGzExtractor, type BundleExtractor } from './release/extract.js';
import { createWranglerClient, type WranglerClient } from './providers/cloudflare/wrangler.js';
import { createNodeStdinReader } from './recovery/bootstrap.js';
import type { ReconcileRuntime } from './providers/cloudflare/reconciler.js';

export interface RuntimeHooks {
	fs?: FileSystem;
	http?: HttpClient;
	process?: ProcessRunner;
	releases?: ReleaseResolver;
	wrangler?: WranglerClient;
	extractor?: BundleExtractor;
	now?: () => Date;
	env?: NodeJS.ProcessEnv;
	wranglerBin?: string;
	smokeAttempts?: number;
	smokeBackoffMs?: number;
	smokeTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	readStdin?: () => Promise<Uint8Array>;
	recoveryPath?: string;
	randomBytes?: (size: number) => Uint8Array;
}

export function createRuntime(command: ParsedCommand, hooks: RuntimeHooks = {}): ReconcileRuntime {
	const fs = hooks.fs ?? createNodeFileSystem();
	const http = hooks.http ?? createFetchHttpClient();
	const env = hooks.env ?? process.env;
	const processRunner = hooks.process ?? createNodeProcessRunner();
	const wrangler =
		hooks.wrangler ??
		createWranglerClient({
			runner: processRunner,
			accountId: command.accountId,
			env,
			wranglerBin: hooks.wranglerBin
		});
	return {
		fs,
		http,
		releases: hooks.releases ?? createGithubReleaseResolver(http),
		wrangler,
		extractor: hooks.extractor ?? createTarGzExtractor(fs),
		now: hooks.now ?? (() => new Date()),
		env,
		smokeAttempts: hooks.smokeAttempts,
		smokeBackoffMs: hooks.smokeBackoffMs,
		smokeTimeoutMs: hooks.smokeTimeoutMs,
		sleep: hooks.sleep,
		readStdin: hooks.readStdin ?? createNodeStdinReader(),
		recoveryPath: hooks.recoveryPath,
		randomBytes: hooks.randomBytes
	};
}
