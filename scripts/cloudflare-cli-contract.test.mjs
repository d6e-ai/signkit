import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const cfBin = join(dirname(require.resolve('cf/package.json')), 'bin/cf');
const accountId = '00000000000000000000000000000000';
const databaseId = '11111111-1111-4111-8111-111111111111';

// The real pinned cf executable talks ONLY to this synthetic local API. No
// account credential or parent environment is inherited. These are CLI contract
// tests, not evidence of a remote Cloudflare deployment.
test('packaged cf returns the resource and remote migration shapes consumed by the installer', async () => {
	const context = await mkdtemp(join(tmpdir(), 'signkit-cf-contract-'));
	const requests = [];
	const database = new DatabaseSync(':memory:');
	const server = createServer(async (request, response) => {
		assert.equal(request.headers.authorization, 'Bearer synthetic-cf-contract-token');
		const url = new URL(request.url, 'http://localhost');
		let body = '';
		for await (const part of request) body += part.toString();
		requests.push({ method: request.method, path: url.pathname, search: url.search, body });
		let result;
		if (url.pathname === '/client/v4/accounts') {
			assert.equal(url.searchParams.get('per_page'), '50');
			result = [{ id: accountId, name: 'Synthetic fixture' }];
		} else if (url.pathname.endsWith('/d1/database')) {
			if (request.method === 'POST') {
				assert.deepEqual(JSON.parse(body), { name: 'fixture' });
				result = { uuid: databaseId, name: 'fixture' };
			} else {
				assert.equal(url.searchParams.get('per_page'), '50');
				result = [{ uuid: databaseId, name: `fixture-page-${url.searchParams.get('page')}` }];
			}
		} else if (url.pathname.endsWith('/query')) {
			const { sql, params = [] } = JSON.parse(body);
			let rows = [];
			try {
				if (/^\s*SELECT\b/i.test(sql)) {
					rows = database.prepare(sql).all(...params);
				} else if (params.length > 0) {
					database.prepare(sql).run(...params);
				} else {
					database.exec(sql);
				}
			} catch (error) {
				response.writeHead(400, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({ success: false, errors: [{ message: error.message }], result: null })
				);
				return;
			}
			result = [
				{
					success: true,
					results: rows,
					meta: { duration: 0 }
				}
			];
		} else {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					success: false,
					errors: [{ message: 'Unexpected fixture request' }],
					result: null
				})
			);
			return;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				success: true,
				errors: [],
				messages: [],
				result,
				...(!url.pathname.endsWith('/query')
					? { result_info: { page: 1, per_page: 50, total_count: result.length } }
					: {})
			})
		);
	});
	try {
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const baseUrl = `http://127.0.0.1:${server.address().port}/client/v4`;
		await mkdir(join(context, 'migrations'));
		await writeFile(join(context, 'migrations/0001_fixture.sql'), 'CREATE TABLE fixture(id TEXT);');
		await writeFile(
			join(context, 'migrations/0002_fixture.sql'),
			'CREATE TABLE fixture_two(id TEXT);'
		);
		async function run(args, expectedCode = 0) {
			return await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [cfBin, ...args], {
					cwd: context,
					env: {
						CLOUDFLARE_API_TOKEN: 'synthetic-cf-contract-token',
						CLOUDFLARE_ACCOUNT_ID: accountId,
						CLOUDFLARE_API_BASE_URL: baseUrl,
						XDG_CONFIG_HOME: join(context, '.config'),
						CI: '1',
						NO_COLOR: '1',
						DO_NOT_TRACK: '1',
						CF_SEND_TELEMETRY: 'false'
					},
					stdio: ['ignore', 'pipe', 'pipe']
				});
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', (chunk) => {
					stdout += chunk;
				});
				child.stderr.on('data', (chunk) => {
					stderr += chunk;
				});
				child.on('error', reject);
				child.on('close', (code) => {
					if (code !== expectedCode) {
						reject(
							new Error(`cf ${args.join(' ')} exited ${code}, expected ${expectedCode}: ${stderr}`)
						);
					} else {
						resolve(code === 0 ? JSON.parse(stdout) : { stdout, stderr });
					}
				});
			});
		}
		assert.deepEqual(await run(['accounts', 'list', '--page', '1', '--per-page', '50']), [
			{ id: accountId, name: 'Synthetic fixture' }
		]);
		for (const page of ['1', '2']) {
			assert.deepEqual(await run(['d1', 'list', '--page', page, '--per-page', '50']), [
				{ uuid: databaseId, name: `fixture-page-${page}` }
			]);
		}
		assert.ok(requests.some((request) => new URLSearchParams(request.search).get('page') === '2'));
		assert.deepEqual(await run(['d1', 'create', '--name', 'fixture']), {
			uuid: databaseId,
			name: 'fixture'
		});
		assert.deepEqual(
			await run(['d1', 'migrations', 'list', databaseId, '--dir', join(context, 'migrations')]),
			[{ Name: '0001_fixture.sql' }, { Name: '0002_fixture.sql' }]
		);
		const ledgerQuery = [
			'd1',
			'query',
			databaseId,
			'--sql',
			'SELECT name FROM d1_migrations ORDER BY id'
		];
		// Real SQL, starting without a ledger: a missing CREATE in cf's listing
		// would fail this read instead of being hidden by a canned API response.
		assert.deepEqual((await run(ledgerQuery))[0].results, []);
		assert.deepEqual(
			await run(['d1', 'migrations', 'apply', databaseId, '--dir', join(context, 'migrations')]),
			[
				{ name: '0001_fixture.sql', status: '✅' },
				{ name: '0002_fixture.sql', status: '✅' }
			]
		);
		assert.deepEqual((await run(ledgerQuery))[0].results, [
			{ name: '0001_fixture.sql' },
			{ name: '0002_fixture.sql' }
		]);
		assert.deepEqual(
			await run(['d1', 'migrations', 'list', databaseId, '--dir', join(context, 'migrations')]),
			[]
		);
		assert.deepEqual(
			database
				.prepare('PRAGMA table_info(d1_migrations)')
				.all()
				.map((column) => column.name),
			['id', 'name', 'applied_at']
		);
		assert.ok(
			requests.some(
				(request) =>
					request.body.includes('CREATE TABLE fixture_two') && request.body.includes('INSERT INTO')
			)
		);
		assert.ok(requests.some((request) => request.path.endsWith('/query')));
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		database.close();
		await rm(context, { recursive: true, force: true });
	}
});
