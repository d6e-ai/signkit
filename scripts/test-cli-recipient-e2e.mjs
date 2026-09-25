/**
 * Real-backend, browserless signing smoke for a disposable PostgreSQL + S3
 * installation. OAuth and mail delivery are deliberately outside this test:
 * the test seeds only its own API key, then opens the invitation capability
 * from the encrypted local outbox before any delivery drain can erase it.
 *
 * Never point DATABASE_URL or S3_ENDPOINT at shared or production resources.
 * This script creates a bucket and writes records, and intentionally never
 * prints credentials, invitation contents, or server diagnostics.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const databaseUrl = process.env.POSTGRES_TEST_URL;
const s3Endpoint = process.env.S3_ENDPOINT;
const s3Bucket = process.env.S3_BUCKET;
const s3AccessKey = process.env.S3_ACCESS_KEY_ID;
const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY;
const cliBinary = resolve('cli/target/debug/signkit');
if (
	!databaseUrl ||
	!s3Endpoint ||
	!s3Bucket ||
	!s3AccessKey ||
	!s3SecretKey ||
	!existsSync(cliBinary)
) {
	throw new Error('CLI E2E requires a built CLI and disposable PostgreSQL/S3 configuration');
}
for (const endpoint of [databaseUrl, s3Endpoint]) {
	const url = new URL(endpoint);
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
		throw new Error('CLI E2E accepts loopback PostgreSQL/S3 endpoints only');
	}
}
if (new URL(databaseUrl).pathname !== '/signkit_cli_e2e' || s3Bucket !== 'signkit-cli-e2e') {
	throw new Error('CLI E2E requires the dedicated signkit_cli_e2e database and bucket');
}

const sql = postgres(databaseUrl, { max: 2, prepare: false });
const objects = new S3Client({
	endpoint: s3Endpoint,
	region: process.env.S3_REGION || 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey }
});
const temp = await mkdtemp(join(tmpdir(), 'signkit-cli-e2e-'));
const apiKey = `signkit_${randomBytes(32).toString('base64url')}`;
const deliveryKey = randomBytes(32);
const workerSecret = randomBytes(32).toString('base64url');
const ownerId = `cli-e2e-${uuidv7()}`;
const serverPort = await freePort();
const baseUrl = `http://127.0.0.1:${serverPort}`;
const serverEnv = {
	...process.env,
	HOST: '127.0.0.1',
	PORT: String(serverPort),
	DATABASE_URL: databaseUrl,
	SIGNKIT_PUBLIC_ORIGIN: 'https://signkit.invalid',
	SIGNKIT_EMAIL_FROM: 'noreply@signkit.invalid',
	SIGNKIT_EMAIL_FROM_NAME: 'SignKit Test',
	SIGNKIT_MAIL_PROVIDER: 'smtp',
	SIGNKIT_SMTP_HOST: '127.0.0.1',
	SIGNKIT_SMTP_PORT: '1025',
	SIGNKIT_SMTP_SECURE: 'false',
	SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
	DELIVERY_ENCRYPTION_KEY: deliveryKey.toString('base64'),
	DELIVERY_WORKER_SECRET: workerSecret
};
let server;
let serverLogs = '';

try {
	await waitForObjectStore();
	try {
		await objects.send(new CreateBucketCommand({ Bucket: s3Bucket }));
	} catch (error) {
		if (error?.name !== 'BucketAlreadyOwnedByYou') throw error;
	}
	await seedSenderKey();
	server = spawn(process.execPath, ['build/node/index.js'], {
		cwd: process.cwd(),
		env: serverEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	for (const stream of [server.stdout, server.stderr]) {
		stream.on('data', (chunk) => {
			serverLogs += chunk.toString('utf8');
			if (serverLogs.length > 1024 * 1024) server.kill('SIGKILL');
		});
	}
	await waitForServer(server);

	const created = await cli(['envelopes', 'create', '--title', 'Synthetic CLI agreement']);
	const envelopeId = created.envelope?.id;
	assert.match(envelopeId, UUID_V7);

	const sourcePdf = join(temp, 'source.pdf');
	await writeFile(sourcePdf, makePdf());
	const uploaded = await cli([
		'envelopes',
		'upload-pdf',
		envelopeId,
		'--file',
		sourcePdf,
		'--expected-generation',
		'0',
		'--title',
		'Synthetic agreement'
	]);
	assert.equal(uploaded.revision?.generation, 1);

	const draft = await cli(['envelopes', 'draft', envelopeId]);
	const documentId = draft.documentSet?.documents?.[0]?.id;
	assert.match(documentId, UUID_V7);

	const readyFile = await jsonFile('ready.json', {
		expectedGeneration: 1,
		recipients: [
			{
				email: 'recipient@signkit.invalid',
				name: 'Test Recipient',
				role: 'signer',
				locale: 'en',
				routingOrder: 1
			}
		]
	});
	const ready = await cli(['envelopes', 'ready', envelopeId, '--file', readyFile]);
	assert.equal(ready.ready?.status, 'ready');
	const recipientId = ready.ready?.recipients?.[0]?.id;
	assert.match(recipientId, UUID_V7);

	const fieldFile = await jsonFile('fields.json', {
		expectedGeneration: 1,
		expectedFieldGeneration: 0,
		fields: [
			{
				recipientId,
				documentId,
				fieldType: 'signature',
				label: 'Signature',
				required: true,
				position: 0,
				geometry: { page: 1, x: 0.15, y: 0.75, width: 0.3, height: 0.07 }
			}
		]
	});
	const placed = await cli(['envelopes', 'fields', envelopeId, '--file', fieldFile]);
	assert.equal(placed.fields?.fieldGeneration, 1);

	const sendFile = await jsonFile('send.json', {
		expectedGeneration: 1,
		expectedReadyAuditEventId: ready.ready.auditEventId
	});
	const sent = await cli(['envelopes', 'send', envelopeId, '--file', sendFile]);
	assert.equal(sent.sent?.envelopeId, envelopeId);

	// This is test-only credential acquisition from the actual encrypted
	// invitation outbox. The sender CLI never receives or displays this token.
	const recipientCapability = await openInvitation(envelopeId, recipientId);
	const recipient = { recipientCapability };
	const context = await cli(['recipient', 'context'], recipient);
	assert.equal(context.access?.recipientId, recipientId);
	const documents = await cli(['recipient', 'documents'], recipient);
	assert.equal(documents.fieldGeneration, 1);
	assert.equal(documents.documents?.[0]?.documentId, documentId);
	const fieldId = documents.fields?.[0]?.id;
	assert.match(fieldId, UUID_V7);

	const reviewedPdf = join(temp, 'reviewed.pdf');
	await cli(
		['recipient', 'pdf', envelopeId, '--document-id', documentId, '--output', reviewedPdf],
		recipient
	);
	assert.ok((await readFile(reviewedPdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));

	const viewedFile = await jsonFile('viewed.json', { envelopeId, recipientId });
	await cli(
		['recipient', 'viewed', '--file', viewedFile, '--consent', '--idempotency-key', uuidv7()],
		recipient
	);
	const signFile = await jsonFile('sign.json', {
		envelopeId,
		recipientId,
		expectedFieldGeneration: documents.fieldGeneration,
		values: [{ fieldId, value: 'Test Recipient' }]
	});
	const signed = await cli(
		['recipient', 'sign', '--file', signFile, '--consent', '--idempotency-key', uuidv7()],
		recipient
	);
	assert.equal(signed.signed?.envelopeStatus, 'completed');

	const completed = await cli(['envelopes', 'get', envelopeId]);
	assert.equal(completed.envelope?.status, 'completed');
	const audit = await sql`
		SELECT event_type, actor_type, actor_id, payload_json
		FROM audit_event WHERE envelope_id = ${envelopeId} ORDER BY sequence
	`;
	assert.ok(
		audit.some((event) => event.event_type === 'envelope.sent' && event.actor_type === 'agent')
	);
	assert.ok(
		audit.some(
			(event) =>
				event.event_type === 'recipient.signed' &&
				event.actor_type === 'recipient' &&
				event.actor_id === recipientId
		)
	);
	assert.ok(audit.every((event) => !event.payload_json.includes(recipientCapability)));

	let published = false;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const response = await fetch(`${baseUrl}/api/v1/system/completion-artifacts/drain`, {
			method: 'POST',
			headers: { authorization: `Bearer ${workerSecret}` }
		});
		assert.equal(response.status, 200, 'completion drain must succeed');
		const status = await cli(['envelopes', 'completion-artifact', envelopeId]);
		if (status.completionArtifact?.status === 'published') {
			published = true;
			break;
		}
		await delay(250);
	}
	assert.ok(published, 'completion artifact must publish');
	const evidencePath = join(temp, 'evidence.json');
	const executedPath = join(temp, 'executed.pdf');
	await cli(['envelopes', 'evidence', envelopeId, '--output', evidencePath]);
	await cli(['envelopes', 'pdf', envelopeId, '--output', executedPath]);
	const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
	assert.equal(evidence.schema, 'signkit-completion-manifest-v1');
	assert.equal(evidence.envelopeId, envelopeId);
	assert.ok(
		evidence.recipients.some((item) => item.id === recipientId && item.status === 'completed')
	);
	assert.ok((await readFile(executedPath)).subarray(0, 5).equals(Buffer.from('%PDF-')));

	const approvalEnvelope = await cli(['envelopes', 'create', '--title', 'Synthetic CLI approval']);
	const approvalEnvelopeId = approvalEnvelope.envelope?.id;
	assert.match(approvalEnvelopeId, UUID_V7);
	await cli([
		'envelopes',
		'upload-pdf',
		approvalEnvelopeId,
		'--file',
		sourcePdf,
		'--expected-generation',
		'0',
		'--title',
		'Synthetic approval'
	]);
	const approvalReadyFile = await jsonFile('approval-ready.json', {
		expectedGeneration: 1,
		recipients: [
			{
				email: 'approver@signkit.invalid',
				name: 'Test Approver',
				role: 'approver',
				locale: 'en',
				routingOrder: 1
			}
		]
	});
	const approvalReady = await cli([
		'envelopes',
		'ready',
		approvalEnvelopeId,
		'--file',
		approvalReadyFile
	]);
	const approverId = approvalReady.ready?.recipients?.[0]?.id;
	assert.match(approverId, UUID_V7);
	const approvalSendFile = await jsonFile('approval-send.json', {
		expectedGeneration: 1,
		expectedReadyAuditEventId: approvalReady.ready.auditEventId
	});
	await cli(['envelopes', 'send', approvalEnvelopeId, '--file', approvalSendFile]);
	const approverCapability = await openInvitation(approvalEnvelopeId, approverId);
	const approver = { recipientCapability: approverCapability };
	const approvalContext = await cli(['recipient', 'context'], approver);
	assert.equal(approvalContext.access?.recipientId, approverId);
	const approvalDocuments = await cli(['recipient', 'documents'], approver);
	const approvalDocumentId = approvalDocuments.documents?.[0]?.documentId;
	assert.match(approvalDocumentId, UUID_V7);
	const approvalPdf = join(temp, 'approval-review.pdf');
	await cli(
		[
			'recipient',
			'pdf',
			approvalEnvelopeId,
			'--document-id',
			approvalDocumentId,
			'--output',
			approvalPdf
		],
		approver
	);
	assert.ok((await readFile(approvalPdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));
	const approvalActionFile = await jsonFile('approval-action.json', {
		envelopeId: approvalEnvelopeId,
		recipientId: approverId
	});
	await cli(
		[
			'recipient',
			'viewed',
			'--file',
			approvalActionFile,
			'--consent',
			'--idempotency-key',
			uuidv7()
		],
		approver
	);
	const approved = await cli(
		[
			'recipient',
			'approve',
			'--file',
			approvalActionFile,
			'--consent',
			'--idempotency-key',
			uuidv7()
		],
		approver
	);
	assert.equal(approved.approved?.envelopeStatus, 'completed');
	const approvalAudit = await sql`
		SELECT event_type, actor_type, actor_id, payload_json
		FROM audit_event WHERE envelope_id = ${approvalEnvelopeId} ORDER BY sequence
	`;
	assert.ok(
		approvalAudit.some(
			(event) =>
				event.event_type === 'recipient.approved' &&
				event.actor_type === 'recipient' &&
				event.actor_id === approverId
		)
	);
	assert.ok(approvalAudit.every((event) => !event.payload_json.includes(approverCapability)));
	for (const secret of [apiKey, recipientCapability, approverCapability]) {
		assert.ok(!serverLogs.includes(secret), 'server logs must not contain credentials');
	}
	process.stdout.write('Real-backend browserless CLI signing and approval E2E passed\n');
} finally {
	if (server && server.exitCode === null) {
		const exited = new Promise((resolveExit) => server.once('exit', resolveExit));
		server.kill('SIGTERM');
		await Promise.race([exited, delay(2_000)]);
		if (server.exitCode === null) server.kill('SIGKILL');
	}
	await objects.destroy();
	await sql.end({ timeout: 2 });
	await rm(temp, { recursive: true, force: true });
}

async function freePort() {
	const probe = createServer();
	await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
	const port = probe.address().port;
	await new Promise((resolveClose) => probe.close(resolveClose));
	return port;
}

async function waitForObjectStore() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			// An unauthenticated S3 root may return 403, but any HTTP response
			// proves the disposable object-storage process is listening.
			await fetch(s3Endpoint);
			return;
		} catch {
			// The disposable container may still be starting.
		}
		await delay(250);
	}
	throw new Error('Disposable S3 service did not start');
}

async function seedSenderKey() {
	const now = new Date();
	const expires = new Date(now.valueOf() + 24 * 60 * 60 * 1_000);
	const tokenHash = createHash('sha256').update(apiKey).digest('hex');
	await sql`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES (${ownerId}, 'owner', 'active', ${now}, ${now})
	`;
	await sql`
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json, owner_user_id, created_at, expires_at
		)
		VALUES (
			${uuidv7()}, 'CLI E2E', ${tokenHash}, ${apiKey.slice(0, 16)},
			'["drafts:write","envelopes:read","envelopes:send"]', ${ownerId}, ${now}, ${expires}
		)
	`;
}

async function waitForServer(child) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (child.exitCode !== null) throw new Error('Built Node server exited before readiness');
		try {
			const response = await fetch(`${baseUrl}/api/v1/system/capabilities`);
			if (response.ok) return;
		} catch {
			// The loopback listener may still be starting.
		}
		await delay(125);
	}
	throw new Error('Built Node server did not start');
}

async function jsonFile(name, body) {
	const path = join(temp, name);
	await writeFile(path, JSON.stringify(body), { mode: 0o600 });
	return path;
}

async function cli(args, { recipientCapability } = {}) {
	const env = { ...process.env, SIGNKIT_BASE_URL: baseUrl };
	delete env.SIGNKIT_API_KEY;
	delete env.SIGNKIT_RECIPIENT_CAPABILITY;
	if (recipientCapability) env.SIGNKIT_RECIPIENT_CAPABILITY = recipientCapability;
	else env.SIGNKIT_API_KEY = apiKey;
	const child = spawn(cliBinary, ['--raw', ...args], {
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
		if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL');
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
		if (stderr.length > 2 * 1024 * 1024) child.kill('SIGKILL');
	});
	const code = await new Promise((resolveExit) => child.once('exit', resolveExit));
	for (const secret of [apiKey, recipientCapability]) {
		if (secret) {
			assert.ok(!stdout.includes(secret), 'CLI stdout must not contain credentials');
			assert.ok(!stderr.includes(secret), 'CLI stderr must not contain credentials');
		}
	}
	if (code !== 0) throw new Error(`CLI ${args[0]} ${args[1]} failed with exit ${code}`);
	return JSON.parse(stdout);
}

async function openInvitation(envelopeId, recipientId) {
	const rows = await sql`
		SELECT id, sealed_capability, capability_hash
		FROM delivery_outbox
		WHERE envelope_id = ${envelopeId} AND recipient_id = ${recipientId}
			AND kind = 'recipient_invitation'
	`;
	assert.equal(rows.length, 1);
	const sealed = rows[0].sealed_capability;
	assert.match(sealed, /^skdc1_[A-Za-z0-9_-]+$/);
	const payload = Buffer.from(sealed.slice(6), 'base64url');
	const iv = payload.subarray(0, 12);
	const tag = payload.subarray(payload.length - 16);
	const ciphertext = payload.subarray(12, payload.length - 16);
	const decipher = createDecipheriv('aes-256-gcm', deliveryKey, iv);
	decipher.setAAD(
		Buffer.from(['signkit-delivery-capability-v1', envelopeId, recipientId, rows[0].id].join('\0'))
	);
	decipher.setAuthTag(tag);
	const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	assert.match(token, /^skr1_[A-Za-z0-9_-]{43}$/);
	assert.equal(createHash('sha256').update(token).digest('hex'), rows[0].capability_hash);
	return token;
}

function makePdf() {
	const content = 'BT /F1 18 Tf 72 700 Td (Synthetic SignKit agreement) Tj ET\n';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) {
		pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf);
}
