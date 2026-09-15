// Fail-closed wrapper for the Vitest browser project.
//
// Root cause it guards: @vitest/mocker's `vitest:browser:esm-injector`
// rewrites dynamic import() calls to
// globalThis["__vitest_browser_runner__"].wrapDynamicImport(...) in every Vite
// environment, including SSR. SvelteKit dev middleware SSR-loads
// .svelte-kit/generated/server/internal.js (get_hooks) server-side where that
// browser-only global does not exist, producing
// "TypeError: Cannot read properties of undefined (reading
// 'wrapDynamicImport')". SvelteKit dev swallows it into fallback hooks, so the
// suite still exits 0 while stderr carries a real SSR failure.
//
// vite.config.ts installs a Node-side passthrough for that global; this
// wrapper treats any reappearance of the signature as failure (and preserves
// Vitest's own exit code otherwise) so `pnpm run test:browser` and CI fail
// instead of silently passing.
import { spawn } from 'node:child_process';

const FAILURE_SIGNATURES = [
	/wrapDynamicImport/,
	/TypeError:\s*Cannot read properties of undefined/,
	/Unhandled (?:Rejection|Error)/,
	/Error when evaluating SSR module/
];

const args = ['exec', 'vitest', '--project', 'browser', '--run', ...process.argv.slice(2)];
const child = spawn('pnpm', args, {
	cwd: process.cwd(),
	env: process.env,
	stdio: ['inherit', 'pipe', 'pipe']
});

let output = '';
const forward = (chunk, stream) => {
	const text = chunk.toString();
	output += text;
	stream.write(chunk);
};
child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
child.stderr.on('data', (chunk) => forward(chunk, process.stderr));

const exitCode = await new Promise((resolve, reject) => {
	child.on('error', reject);
	child.on('close', resolve);
});

const hit = FAILURE_SIGNATURES.find((pattern) => pattern.test(output));
if (hit) {
	console.error(
		`\ntest-browser-guard: detected release-blocking browser SSR failure (matched ${hit}). ` +
			`See https://github.com/vitest-dev/vitest/issues/10319. Failing closed.`
	);
	process.exit(1);
}
process.exit(exitCode ?? 1);
