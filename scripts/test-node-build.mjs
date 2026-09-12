import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const port = 40_000 + (process.pid % 10_000);
const server = spawn(process.execPath, ['build/node/index.js'], {
	cwd: process.cwd(),
	env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

try {
	await waitUntilListening();
	const response = await fetch(`http://127.0.0.1:${port}/sign?access=invalid`);
	assert.equal(response.status, 200);
	const csp = response.headers.get('content-security-policy');
	assert.ok(csp, 'built Node response must include a CSP header');
	for (const directive of [
		"default-src 'self'",
		"base-uri 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"script-src 'self'"
	]) {
		assert.ok(csp.includes(directive), `CSP must include ${directive}`);
	}
	assert.ok(!csp.includes("'unsafe-eval'"), 'CSP must not permit unsafe-eval');
	const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
	assert.ok(nonce, 'SvelteKit must add a script nonce for dynamic pages');
	const body = await response.text();
	assert.ok(body.includes(`nonce="${nonce}"`), 'the CSP nonce must match rendered scripts');
} finally {
	if (server.exitCode === null) {
		const exited = new Promise((resolve) => server.once('exit', resolve));
		server.kill('SIGTERM');
		const forceStop = setTimeout(() => server.kill('SIGKILL'), 1_000);
		await exited;
		clearTimeout(forceStop);
	}
}

async function waitUntilListening() {
	const deadline = Date.now() + 10_000;
	while (!output.includes('Listening on')) {
		if (server.exitCode !== null) throw new Error(`Node adapter exited early: ${output}`);
		if (Date.now() > deadline) throw new Error(`Node adapter did not start: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
