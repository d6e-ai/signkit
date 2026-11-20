import { dirname, join } from 'node:path';
import {
	ENROLLMENT_PATH,
	ENROLLMENT_TIMEOUT_MS,
	ENROLLMENT_TOKEN_ENV,
	MAX_ENROLLMENT_RESPONSE_BYTES
} from '../constants.js';
import { CliError, generic, usage, type ExitCode } from '../cli/errors.js';
import {
	canonicalConsoleOrigin,
	canonicalConsoleOrigins,
	hostnameFromOrigin,
	isValidEmailAddress,
	MAX_CONSOLE_ORIGINS
} from '../cli/urls.js';
import type { FileSystem } from '../runtime/fs.js';
import { utf8, type HttpClient, type HttpResponse } from '../runtime/http.js';
import {
	parseOAuthSecretInput,
	readRetainedSidecar,
	writeRetainedSidecarExclusive,
	type OAuthSecretInput
} from '../recovery/bootstrap.js';

/**
 * Console enrollment: on a pristine initial deploy, a single-use D6E Auth
 * enrollment token (env only, never argv) is exchanged for this server's OAuth
 * client. The returned pair is used exactly where the stdin OAuth JSON is used
 * otherwise, so it lands in the retained recovery file and retries reuse it.
 * The non-secret part of the response is retained beside the recovery file as
 * the enrollment record, so a retry restores the same defaults without calling
 * D6E Auth again. The token and the client secret are never printed.
 */

export const ENROLLMENT_TOKEN_PATTERN: RegExp = /^d6ee_[A-Za-z0-9_-]{43}$/;
export const ENROLLMENT_RECORD_SCHEMA_VERSION = 1 as const;
const MAX_ENROLLMENT_RECORD_BYTES = 8 * 1024;
const SERVER_ID_PATTERN: RegExp = /^[\x21-\x7e]{1,200}$/;
const ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{0,63}$/;

export interface EnrollmentRecord {
	schemaVersion: typeof ENROLLMENT_RECORD_SCHEMA_VERSION;
	kind: 'signkit';
	serverId: string;
	publicOrigin: string;
	d6eAuthBaseUrl: string;
	bootstrapOwnerEmail: string;
	consoleOrigins: string[];
}

export interface EnrollmentResponse {
	record: EnrollmentRecord;
	oauth: OAuthSecretInput;
}

export interface EnrollmentRequest {
	http: HttpClient;
	baseUrl: string;
	token: string;
	publicOrigin: string;
	name: string;
	timeoutMs?: number;
}

/**
 * Reads `D6E_ENROLLMENT_TOKEN`. Absent or empty means "no enrollment". A value
 * that is not exactly the issued token shape is refused without echoing it.
 */
export function resolveEnrollmentToken(env: NodeJS.ProcessEnv): string | undefined {
	const raw: string | undefined = env[ENROLLMENT_TOKEN_ENV];
	if (raw === undefined) return undefined;
	const token: string = raw.trim();
	if (token.length === 0) return undefined;
	if (!ENROLLMENT_TOKEN_PATTERN.test(token)) {
		throw usage(
			`${ENROLLMENT_TOKEN_ENV} is not a console enrollment token (expected d6ee_ followed by 43 base64url characters); the value is never printed`
		);
	}
	return token;
}

export function resolveEnrollmentRecordPath(recoveryPath: string): string {
	return join(dirname(recoveryPath), 'enrollment.json');
}

export function defaultServerName(publicOrigin: string): string {
	return hostnameFromOrigin(publicOrigin);
}

function enrollmentError(message: string, exitCode: ExitCode, code: string): CliError {
	return new CliError(message, exitCode, code);
}

/**
 * Calls `POST {baseUrl}/api/v1/console/enrollments` once. Redirects are never
 * followed, so the bearer token cannot be replayed to another URL. Every
 * outcome other than a fully valid success throws a `CliError` whose message
 * never contains the token or any secret from the response.
 */
export async function requestConsoleEnrollment(
	request: EnrollmentRequest
): Promise<EnrollmentResponse> {
	const endpoint: string = `${request.baseUrl}${ENROLLMENT_PATH}`;
	const host: string = new URL(request.baseUrl).hostname;
	let response: HttpResponse;
	try {
		response = await request.http.request({
			url: endpoint,
			method: 'POST',
			headers: {
				authorization: `Bearer ${request.token}`,
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({
				kind: 'signkit',
				publicOrigin: request.publicOrigin,
				name: request.name
			}),
			maxBytes: MAX_ENROLLMENT_RESPONSE_BYTES,
			allowedHosts: new Set([host]),
			requireHttps: true,
			followRedirects: false,
			timeoutMs: request.timeoutMs ?? ENROLLMENT_TIMEOUT_MS
		});
	} catch (error) {
		const detail: string = redact(
			error instanceof Error ? error.message : String(error),
			request.token
		);
		throw enrollmentError(
			`D6E Auth console enrollment at ${endpoint} could not be completed (${detail}). D6E Auth may or may not have processed the request. Rerun the same command with the same token within 30 minutes of issuing it: D6E Auth answers a repeated enrollment of ${request.publicOrigin} with the same server and a new client secret. If the token has expired and a registration for ${request.publicOrigin} exists without its secret here, an organization owner or admin can disable it, or rotate its secret, under the organization's Auth Clients in the D6E account, then issue a new token.`,
			5,
			'enrollment_unavailable'
		);
	}

	const status: number = response.status;
	if (status === 200 || status === 201) {
		return parseEnrollmentSuccess(response, request);
	}
	const errorCode: string | undefined = responseErrorCode(response);
	const suffix: string = errorCode ? ` (${errorCode})` : '';
	if (status === 401) {
		throw enrollmentError(
			`D6E Auth rejected ${ENROLLMENT_TOKEN_ENV}${suffix}: the token is invalid, expired, or already used. Issue a new enrollment token from the SignKit console and rerun. Nothing was changed in Cloudflare.`,
			6,
			'enrollment_invalid_token'
		);
	}
	if (status === 409) {
		throw enrollmentError(
			`D6E Auth refused the console enrollment${suffix}: an active SignKit server is already registered for ${request.publicOrigin}, or the email of the account that issued the token is not verified. Disable the existing registration under the organization's Auth Clients in the D6E account, or verify the email in D6E Auth, then issue a new token. Nothing was changed in Cloudflare.`,
			4,
			'enrollment_conflict'
		);
	}
	if (status === 400) {
		throw enrollmentError(
			`D6E Auth rejected the console enrollment request as invalid${suffix}. Check --public-origin/--domain (an https origin without a path) and --server-name (at most 100 characters). Nothing was changed in Cloudflare.`,
			6,
			'enrollment_invalid_request'
		);
	}
	if (status >= 300 && status < 400) {
		throw enrollmentError(
			`D6E Auth answered the console enrollment with a redirect (HTTP ${status}); refusing to follow it with the enrollment token. Check --d6e-auth-base-url. Nothing was changed in Cloudflare.`,
			1,
			'enrollment_redirect'
		);
	}
	if (status === 429 || status >= 500) {
		throw enrollmentError(
			`D6E Auth console enrollment is unavailable (HTTP ${status}${suffix}). D6E Auth may or may not have processed the request; rerun the same command with the same token within 30 minutes of issuing it. Nothing was changed in Cloudflare.`,
			5,
			'enrollment_unavailable'
		);
	}
	throw enrollmentError(
		`D6E Auth console enrollment failed (HTTP ${status}${suffix}). Nothing was changed in Cloudflare.`,
		1,
		'enrollment_failed'
	);
}

function parseEnrollmentSuccess(
	response: HttpResponse,
	request: EnrollmentRequest
): EnrollmentResponse {
	let body: unknown;
	try {
		body = JSON.parse(utf8(response.body));
	} catch {
		throw invalidResponse('the body is not JSON', request, undefined);
	}
	if (!isRecord(body)) {
		throw invalidResponse('the body is not an object', request, undefined);
	}
	const server: unknown = body.server;
	const serverId: string | undefined =
		isRecord(server) && typeof server.id === 'string' && SERVER_ID_PATTERN.test(server.id)
			? server.id
			: undefined;
	if (!isRecord(server) || serverId === undefined) {
		throw invalidResponse('server.id is missing or malformed', request, undefined);
	}
	if (server.kind !== 'signkit') {
		throw invalidResponse('server.kind is not signkit', request, serverId);
	}
	if (canonicalConsoleOrigin(server.origin) !== request.publicOrigin) {
		throw invalidResponse('server.origin does not match --public-origin', request, serverId);
	}
	let oauth: OAuthSecretInput;
	try {
		oauth = parseOAuthSecretInput({
			D6E_AUTH_CLIENT_ID: body.clientId,
			D6E_AUTH_CLIENT_SECRET: body.clientSecret
		});
	} catch {
		throw invalidResponse('clientId or clientSecret is missing or malformed', request, serverId);
	}
	if (
		typeof body.bootstrapOwnerEmail !== 'string' ||
		!isValidEmailAddress(body.bootstrapOwnerEmail)
	) {
		throw invalidResponse('bootstrapOwnerEmail is missing or malformed', request, serverId);
	}
	if (canonicalConsoleOrigin(body.d6eAuthBaseUrl) !== request.baseUrl) {
		throw invalidResponse(
			'd6eAuthBaseUrl does not match the D6E Auth origin this deploy uses (--d6e-auth-base-url)',
			request,
			serverId
		);
	}
	if (!Array.isArray(body.consoleOrigins) || body.consoleOrigins.length > MAX_CONSOLE_ORIGINS) {
		throw invalidResponse('consoleOrigins is missing or malformed', request, serverId);
	}
	let consoleOrigins: string[];
	try {
		consoleOrigins = canonicalConsoleOrigins(body.consoleOrigins, 'consoleOrigins');
	} catch {
		throw invalidResponse('consoleOrigins contains an invalid origin', request, serverId);
	}
	return {
		oauth,
		record: {
			schemaVersion: ENROLLMENT_RECORD_SCHEMA_VERSION,
			kind: 'signkit',
			serverId,
			publicOrigin: request.publicOrigin,
			d6eAuthBaseUrl: request.baseUrl,
			bootstrapOwnerEmail: body.bootstrapOwnerEmail.trim().toLowerCase(),
			consoleOrigins
		}
	};
}

/**
 * A malformed success is not retained: the CLI never stores or uses a client
 * secret from a response it cannot validate. The registration may nevertheless
 * exist in D6E Auth, so the message names the server id when it is known.
 */
function invalidResponse(
	reason: string,
	request: EnrollmentRequest,
	serverId: string | undefined
): CliError {
	const registration = serverId
		? `D6E Auth may have registered server ${serverId} for ${request.publicOrigin}`
		: `D6E Auth may have registered a server for ${request.publicOrigin}`;
	return enrollmentError(
		`D6E Auth returned an unusable console enrollment response (${reason}); nothing was saved and nothing was changed in Cloudflare. ${registration}; rerun with the same token within 30 minutes of issuing it to receive it again with a new client secret, or have an organization owner or admin disable it, or rotate its secret, under the organization's Auth Clients in the D6E account and issue a new token.`,
		1,
		'enrollment_invalid_response'
	);
}

function responseErrorCode(response: HttpResponse): string | undefined {
	try {
		const body: unknown = JSON.parse(utf8(response.body));
		if (isRecord(body) && typeof body.error === 'string' && ERROR_CODE_PATTERN.test(body.error)) {
			return body.error;
		}
	} catch {
		// Error bodies are optional; only the status decides the outcome.
	}
	return undefined;
}

export function serializeEnrollmentRecord(record: EnrollmentRecord): string {
	return `${JSON.stringify(
		{
			schemaVersion: record.schemaVersion,
			kind: record.kind,
			serverId: record.serverId,
			publicOrigin: record.publicOrigin,
			d6eAuthBaseUrl: record.d6eAuthBaseUrl,
			bootstrapOwnerEmail: record.bootstrapOwnerEmail,
			consoleOrigins: record.consoleOrigins
		},
		null,
		'\t'
	)}\n`;
}

export async function writeEnrollmentRecord(
	fs: FileSystem,
	recoveryPath: string,
	record: EnrollmentRecord
): Promise<string> {
	const path: string = resolveEnrollmentRecordPath(recoveryPath);
	await writeRetainedSidecarExclusive(
		fs,
		recoveryPath,
		path,
		serializeEnrollmentRecord(record),
		'enrollment record'
	);
	return path;
}

export async function readEnrollmentRecord(
	fs: FileSystem,
	recoveryPath: string
): Promise<EnrollmentRecord | undefined> {
	const path: string = resolveEnrollmentRecordPath(recoveryPath);
	const text: string | undefined = await readRetainedSidecar(
		fs,
		recoveryPath,
		path,
		MAX_ENROLLMENT_RECORD_BYTES,
		'enrollment record'
	);
	if (text === undefined) return undefined;
	const invalid = (): CliError =>
		generic(
			`enrollment record at ${path} is invalid; restore it from the backup taken with the recovery file`
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw invalid();
	}
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== ENROLLMENT_RECORD_SCHEMA_VERSION ||
		parsed.kind !== 'signkit' ||
		typeof parsed.serverId !== 'string' ||
		!SERVER_ID_PATTERN.test(parsed.serverId) ||
		typeof parsed.publicOrigin !== 'string' ||
		canonicalConsoleOrigin(parsed.publicOrigin) !== parsed.publicOrigin ||
		typeof parsed.d6eAuthBaseUrl !== 'string' ||
		canonicalConsoleOrigin(parsed.d6eAuthBaseUrl) !== parsed.d6eAuthBaseUrl ||
		typeof parsed.bootstrapOwnerEmail !== 'string' ||
		!isValidEmailAddress(parsed.bootstrapOwnerEmail) ||
		parsed.bootstrapOwnerEmail !== parsed.bootstrapOwnerEmail.trim().toLowerCase() ||
		!Array.isArray(parsed.consoleOrigins)
	) {
		throw invalid();
	}
	let consoleOrigins: string[];
	try {
		consoleOrigins = canonicalConsoleOrigins(parsed.consoleOrigins, 'consoleOrigins');
	} catch {
		throw invalid();
	}
	if (consoleOrigins.length !== parsed.consoleOrigins.length) {
		throw invalid();
	}
	return {
		schemaVersion: ENROLLMENT_RECORD_SCHEMA_VERSION,
		kind: 'signkit',
		serverId: parsed.serverId,
		publicOrigin: parsed.publicOrigin,
		d6eAuthBaseUrl: parsed.d6eAuthBaseUrl,
		bootstrapOwnerEmail: parsed.bootstrapOwnerEmail,
		consoleOrigins
	};
}

function redact(text: string, token: string): string {
	return text.split(token).join('[redacted]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
