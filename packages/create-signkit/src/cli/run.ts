import { PACKAGE_NAME, PACKAGE_VERSION } from '../constants.js';
import { isCliError } from './errors.js';
import { argvRequestsJson, helpText, parseArgv, type ParsedCommand } from './parse.js';
import { assertProviderImplemented } from '../providers/registry.js';
import { reconcileCloudflare, type ReconcileResult } from '../providers/cloudflare/reconciler.js';
import { createRuntime, type RuntimeHooks } from '../runtime.js';

export interface RunIo {
	argv: string[];
	stdout: { write(chunk: string): void };
	stderr: { write(chunk: string): void };
	env?: NodeJS.ProcessEnv;
	runtime?: RuntimeHooks;
}

export async function runCreateSignkit(io: RunIo): Promise<number> {
	const jsonRequested = argvRequestsJson(io.argv);
	try {
		const parsed = parseArgv(io.argv);
		if (parsed.kind === 'help') {
			io.stdout.write(helpText());
			return 0;
		}
		if (parsed.kind === 'cli-version') {
			io.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`);
			return 0;
		}
		assertProviderImplemented(parsed.provider);
		const runtime = createRuntime(parsed, { ...io.runtime, env: io.runtime?.env ?? io.env });
		const result = await reconcileCloudflare(parsed, runtime);
		emit(io, parsed, result);
		return result.exitCode;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const exitCode = isCliError(error) ? error.exitCode : 1;
		const code = isCliError(error) ? error.code : 'error';
		if (jsonRequested) {
			io.stdout.write(`${JSON.stringify({ ok: false, code, message }, null, '\t')}\n`);
		} else {
			io.stderr.write(`${message}\n`);
		}
		return exitCode;
	}
}

function emit(io: RunIo, parsed: ParsedCommand, result: ReconcileResult): void {
	if (parsed.json) {
		io.stdout.write(`${JSON.stringify({ ok: result.exitCode === 0, ...result }, null, '\t')}\n`);
		return;
	}
	io.stdout.write(`${result.message}\n`);
	if (result.plan.length > 0) {
		io.stdout.write('Plan:\n');
		for (const step of result.plan) {
			io.stdout.write(`  - ${step.summary}${step.mutating ? ' (mutating)' : ''}\n`);
		}
	}
	if (result.drift.length > 0) {
		io.stdout.write('Drift:\n');
		for (const item of result.drift) {
			io.stdout.write(`  - ${item}\n`);
		}
	}
	if (result.workerUrl) {
		io.stdout.write(`Worker URL: ${result.workerUrl}\n`);
	}
	if (result.d1BackupPath) {
		io.stdout.write(`D1 backup: ${result.d1BackupPath}\n`);
	}
	if (result.provenance) {
		io.stdout.write(
			`Provenance: verified ${result.provenance.repository}/${result.provenance.workflow} ${result.provenance.sourceRef}\n`
		);
	}
	if (result.recoveryPath) {
		io.stdout.write(`Recovery file: ${result.recoveryPath}\n`);
	}
	if (result.recoveryFingerprint) {
		io.stdout.write(`Recovery fingerprint: ${result.recoveryFingerprint}\n`);
	}
	if (result.missingSecrets.length > 0) {
		io.stdout.write(`Missing secrets: ${result.missingSecrets.join(', ')}\n`);
	}
	io.stdout.write(`${result.bootstrapWarning}\n`);
	io.stdout.write(`${result.migrationPolicy}\n`);
	if (result.rollback) {
		io.stdout.write(`${result.rollback.guidance}\n`);
	}
}
