import { Buffer } from 'node:buffer';
import { verify as verifySigstore, TUFError, type Bundle, type VerifyOptions } from 'sigstore';
import { uncompress } from 'snappyjs';
import {
	GITHUB_API_ORIGIN,
	MAX_ATTESTATION_BUNDLE_BYTES,
	MAX_ATTESTATION_LIST_BYTES,
	MAX_ATTESTATION_STATEMENT_BYTES,
	SIGNKIT_REPOSITORY
} from '../constants.js';
import { generic, unavailable } from '../cli/errors.js';
import type { HttpClient } from '../runtime/http.js';
import { utf8 } from '../runtime/http.js';
import type { ResolvedRelease } from './github.js';

const ATTESTATION_API_VERSION = '2026-03-10';
const ATTESTATION_BLOB_HOST = 'tmaproduction.blob.core.windows.net';
const ATTESTATION_BLOB_HOSTS = new Set([ATTESTATION_BLOB_HOST]);
const GITHUB_API_HOSTS = new Set(['api.github.com']);
const MAX_ATTESTATIONS = 10;
const HTTP_TIMEOUT_MS = 10_000;
const SIGSTORE_TIMEOUT_MS = 10_000;
const REPOSITORY_URL = `https://github.com/${SIGNKIT_REPOSITORY}`;
const REPOSITORY_ID = '1365209252';
const REPOSITORY_OWNER_ID = '251581364';
const WORKFLOW_PATH = '.github/workflows/release-cloudflare-bundle.yml';
const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const WORKFLOW_BUILD_TYPE = 'https://actions.github.io/buildtypes/workflow/v1';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export interface ReleaseProvenance {
	status: 'verified';
	mode: 'online';
	repository: typeof SIGNKIT_REPOSITORY;
	workflow: typeof WORKFLOW_PATH;
	sourceRef: string;
	sourceCommit: string;
	subjectName: string;
	subjectSha256: string;
	predicateType: typeof SLSA_PREDICATE_TYPE;
	buildType: typeof WORKFLOW_BUILD_TYPE;
	attestationCount: number;
	trustRoot: 'sigstore-public-good';
}

export interface ProvenanceVerifier {
	verify(release: ResolvedRelease, bundleSha256: string): Promise<ReleaseProvenance>;
}

export type SigstoreBundleVerifier = (bundle: Bundle, options: VerifyOptions) => Promise<unknown>;

export interface GithubCertificatePolicyInput {
	repository: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryOwnerId: string;
	workflowPath: string;
	sourceRef: string;
	commit: string;
	eventName: string;
}

export interface GithubCertificatePolicy {
	workflowIdentity: string;
	verifyOptions: Required<
		Pick<VerifyOptions, 'certificateIssuer' | 'certificateIdentityURI' | 'certificateOIDs'>
	>;
}

interface GithubAttestationList {
	attestations: Array<{ bundle_url: string; repository_id: number }>;
}

interface InTotoStatement {
	_type: string;
	subject: Array<{ name: string; digest: Record<string, string> }>;
	predicateType: string;
	predicate: {
		buildDefinition: {
			buildType: string;
			externalParameters: {
				workflow: { ref: string; repository: string; path: string };
			};
			internalParameters: {
				github: {
					event_name: string;
					repository_id: string;
					repository_owner_id: string;
					runner_environment: string;
				};
			};
			resolvedDependencies: Array<{
				uri: string;
				digest: Record<string, string>;
			}>;
		};
		runDetails: { builder: { id: string } };
	};
}

export function createGithubProvenanceVerifier(
	http: HttpClient,
	verifyBundle: SigstoreBundleVerifier = verifySigstore
): ProvenanceVerifier {
	return {
		verify(release, bundleSha256) {
			return verifyGithubProvenance(http, verifyBundle, release, bundleSha256);
		}
	};
}

async function verifyGithubProvenance(
	http: HttpClient,
	verifyBundle: SigstoreBundleVerifier,
	release: ResolvedRelease,
	bundleSha256: string
): Promise<ReleaseProvenance> {
	const commit = release.commit;
	if (!commit) {
		throw generic('release provenance requires a resolved source commit');
	}
	if (bundleSha256 !== release.manifest.bundle.sha256) {
		throw generic('release provenance subject digest does not match the downloaded bundle');
	}
	const sourceRef = `refs/tags/${release.tag}`;
	const certificatePolicy = createGithubCertificatePolicy({
		repository: SIGNKIT_REPOSITORY,
		repositoryId: REPOSITORY_ID,
		repositoryOwner: 'd6e-ai',
		repositoryOwnerId: REPOSITORY_OWNER_ID,
		workflowPath: WORKFLOW_PATH,
		sourceRef,
		commit,
		eventName: 'push'
	});
	const workflowIdentity = certificatePolicy.workflowIdentity;
	const attestations = await fetchAttestationList(http, bundleSha256);
	if (attestations.length === 0) {
		throw generic('GitHub release provenance is missing for the downloaded Cloudflare bundle');
	}
	if (attestations.length > MAX_ATTESTATIONS) {
		throw generic(`GitHub returned more than ${MAX_ATTESTATIONS} provenance attestations`);
	}

	for (const attestation of attestations) {
		if (String(attestation.repository_id) !== REPOSITORY_ID) {
			throw generic('GitHub returned release provenance for an unexpected repository identity');
		}
		const bundle = await fetchAttestationBundle(http, attestation.bundle_url);
		try {
			await verifyBundle(bundle, {
				...certificatePolicy.verifyOptions,
				ctLogThreshold: 1,
				tlogThreshold: 1,
				timeout: SIGSTORE_TIMEOUT_MS,
				retry: 1,
				tufForceCache: false
			});
		} catch (error) {
			if (isTrustRootUnavailable(error)) {
				throw unavailable('Sigstore trust-root verification is temporarily unavailable');
			}
			throw generic('GitHub release provenance signature or signer identity is invalid');
		}
		const statement = parseStatement(bundle);
		assertStatementMatches(statement, release, bundleSha256, {
			commit,
			sourceRef,
			workflowIdentity
		});
	}

	return {
		status: 'verified',
		mode: 'online',
		repository: SIGNKIT_REPOSITORY,
		workflow: WORKFLOW_PATH,
		sourceRef,
		sourceCommit: commit,
		subjectName: release.manifest.bundle.assetName,
		subjectSha256: bundleSha256,
		predicateType: SLSA_PREDICATE_TYPE,
		buildType: WORKFLOW_BUILD_TYPE,
		attestationCount: attestations.length,
		trustRoot: 'sigstore-public-good'
	};
}

async function fetchAttestationList(
	http: HttpClient,
	bundleSha256: string
): Promise<GithubAttestationList['attestations']> {
	const predicateType = encodeURIComponent(SLSA_PREDICATE_TYPE);
	const url = `${GITHUB_API_ORIGIN}/repos/${SIGNKIT_REPOSITORY}/attestations/sha256:${bundleSha256}?predicate_type=${predicateType}&per_page=${MAX_ATTESTATIONS}`;
	let response;
	try {
		response = await http.request({
			url,
			maxBytes: MAX_ATTESTATION_LIST_BYTES,
			allowedHosts: GITHUB_API_HOSTS,
			timeoutMs: HTTP_TIMEOUT_MS,
			headers: {
				accept: 'application/vnd.github+json',
				'x-github-api-version': ATTESTATION_API_VERSION
			}
		});
	} catch {
		throw unavailable('GitHub release provenance lookup is temporarily unavailable');
	}
	if (response.status !== 200) {
		if (response.status === 404) return [];
		throw unavailable(`GitHub release provenance lookup failed (HTTP ${response.status})`);
	}
	if (/rel="next"/.test(response.headers.link ?? '')) {
		throw generic(`GitHub returned more than ${MAX_ATTESTATIONS} provenance attestations`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8(response.body));
	} catch {
		throw generic('GitHub release provenance response is not valid JSON');
	}
	if (!isObject(parsed) || !Array.isArray(parsed.attestations)) {
		throw generic('GitHub release provenance response has an invalid shape');
	}
	const attestations: GithubAttestationList['attestations'] = [];
	for (const item of parsed.attestations) {
		if (!isObject(item) || typeof item.bundle_url !== 'string') {
			throw generic('GitHub release provenance response contains an invalid attestation');
		}
		if (typeof item.repository_id !== 'number' || !Number.isSafeInteger(item.repository_id)) {
			throw generic('GitHub release provenance response contains an invalid repository identity');
		}
		attestations.push({ bundle_url: item.bundle_url, repository_id: item.repository_id });
	}
	return attestations;
}

async function fetchAttestationBundle(http: HttpClient, bundleUrl: string): Promise<Bundle> {
	assertAttestationBundleUrl(bundleUrl);
	let response;
	try {
		response = await http.request({
			url: bundleUrl,
			maxBytes: MAX_ATTESTATION_BUNDLE_BYTES,
			allowedHosts: ATTESTATION_BLOB_HOSTS,
			timeoutMs: HTTP_TIMEOUT_MS,
			headers: { accept: 'application/x-snappy' }
		});
	} catch {
		throw unavailable('GitHub release provenance bundle download is temporarily unavailable');
	}
	if (response.status !== 200) {
		throw unavailable(`GitHub release provenance bundle download failed (HTTP ${response.status})`);
	}
	let decoded: Uint8Array;
	try {
		decoded = uncompress(response.body, MAX_ATTESTATION_STATEMENT_BYTES);
	} catch {
		throw generic(
			'GitHub release provenance bundle is malformed or exceeds its decoded size limit'
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8(decoded));
	} catch {
		throw generic('GitHub release provenance bundle is not valid JSON');
	}
	if (!isObject(parsed)) {
		throw generic('GitHub release provenance bundle must be a JSON object');
	}
	return parsed as Bundle;
}

function assertAttestationBundleUrl(urlText: string): void {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw generic('GitHub release provenance bundle URL is invalid');
	}
	if (
		url.protocol !== 'https:' ||
		url.hostname !== ATTESTATION_BLOB_HOST ||
		url.username ||
		url.password ||
		url.hash ||
		!new RegExp(`^/attestations/${REPOSITORY_ID}/\\d{4}/\\d{2}/\\d{2}/\\d+\\.json\\.sn$`).test(
			url.pathname
		)
	) {
		throw generic('GitHub release provenance bundle URL is not an allowed GitHub attestation URL');
	}
}

function parseStatement(bundle: Bundle): InTotoStatement {
	const envelope = (bundle as unknown as { dsseEnvelope?: { payload?: string } }).dsseEnvelope;
	if (!envelope || typeof envelope.payload !== 'string') {
		throw generic('GitHub release provenance bundle is missing its signed statement');
	}
	let payload: Uint8Array;
	try {
		payload = Buffer.from(envelope.payload, 'base64');
	} catch {
		throw generic('GitHub release provenance statement encoding is invalid');
	}
	if (payload.byteLength === 0 || payload.byteLength > MAX_ATTESTATION_STATEMENT_BYTES) {
		throw generic('GitHub release provenance statement exceeds its size limit');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8(payload));
	} catch {
		throw generic('GitHub release provenance statement is not valid JSON');
	}
	if (!isObject(parsed)) {
		throw generic('GitHub release provenance statement must be a JSON object');
	}
	return parsed as unknown as InTotoStatement;
}

function assertStatementMatches(
	statement: InTotoStatement,
	release: ResolvedRelease,
	bundleSha256: string,
	expected: { commit: string; sourceRef: string; workflowIdentity: string }
): void {
	if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
		throw generic('GitHub release provenance statement type is not in-toto Statement v1');
	}
	if (statement.predicateType !== SLSA_PREDICATE_TYPE) {
		throw generic('GitHub release provenance predicate type is not SLSA provenance v1');
	}
	if (
		!Array.isArray(statement.subject) ||
		statement.subject.length === 0 ||
		statement.subject.length > 1024
	) {
		throw generic('GitHub release provenance subject list is missing or exceeds its limit');
	}
	for (const subject of statement.subject) {
		if (
			!isObject(subject) ||
			typeof subject.name !== 'string' ||
			subject.name.length === 0 ||
			subject.name.length > 255 ||
			!isObject(subject.digest) ||
			typeof subject.digest.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(subject.digest.sha256)
		) {
			throw generic('GitHub release provenance contains a malformed subject');
		}
	}
	const matchingSubjects = statement.subject.filter(
		(subject) =>
			isObject(subject) &&
			subject.name === release.manifest.bundle.assetName &&
			isObject(subject.digest) &&
			subject.digest.sha256 === bundleSha256
	);
	if (matchingSubjects.length !== 1) {
		throw generic('GitHub release provenance must contain exactly one matching bundle subject');
	}
	const predicate = statement.predicate;
	if (
		!isObject(predicate) ||
		!isObject(predicate.buildDefinition) ||
		!isObject(predicate.runDetails)
	) {
		throw generic('GitHub release provenance predicate has an invalid shape');
	}
	const definition = predicate.buildDefinition;
	if (definition.buildType !== WORKFLOW_BUILD_TYPE) {
		throw generic('GitHub release provenance build type is not the GitHub Actions workflow type');
	}
	const workflow = definition.externalParameters?.workflow;
	if (
		!isObject(workflow) ||
		workflow.repository !== REPOSITORY_URL ||
		workflow.path !== WORKFLOW_PATH ||
		workflow.ref !== expected.sourceRef
	) {
		throw generic('GitHub release provenance workflow parameters do not match the release');
	}
	const github = definition.internalParameters?.github;
	if (
		!isObject(github) ||
		github.event_name !== 'push' ||
		String(github.repository_id) !== REPOSITORY_ID ||
		String(github.repository_owner_id) !== REPOSITORY_OWNER_ID ||
		github.runner_environment !== 'github-hosted'
	) {
		throw generic('GitHub release provenance repository or runner identity is invalid');
	}
	if (!Array.isArray(definition.resolvedDependencies)) {
		throw generic('GitHub release provenance is missing resolved source dependencies');
	}
	const sourceUri = `git+${REPOSITORY_URL}@${expected.sourceRef}`;
	const matchingSources = definition.resolvedDependencies.filter(
		(dependency) =>
			isObject(dependency) &&
			dependency.uri === sourceUri &&
			isObject(dependency.digest) &&
			dependency.digest.gitCommit === expected.commit
	);
	if (matchingSources.length !== 1) {
		throw generic('GitHub release provenance source commit does not match the release tag');
	}
	if (predicate.runDetails.builder?.id !== expected.workflowIdentity) {
		throw generic('GitHub release provenance builder identity does not match the release workflow');
	}
}

export function createGithubCertificatePolicy(
	input: GithubCertificatePolicyInput
): GithubCertificatePolicy {
	const repositoryUrl = `https://github.com/${input.repository}`;
	const repositoryOwnerUrl = `https://github.com/${input.repositoryOwner}`;
	const workflowIdentity = `${repositoryUrl}/${input.workflowPath}@${input.sourceRef}`;
	const values: Record<string, string> = {
		'1.3.6.1.4.1.57264.1.9': workflowIdentity,
		'1.3.6.1.4.1.57264.1.10': input.commit,
		'1.3.6.1.4.1.57264.1.11': 'github-hosted',
		'1.3.6.1.4.1.57264.1.12': repositoryUrl,
		'1.3.6.1.4.1.57264.1.13': input.commit,
		'1.3.6.1.4.1.57264.1.14': input.sourceRef,
		'1.3.6.1.4.1.57264.1.15': input.repositoryId,
		'1.3.6.1.4.1.57264.1.16': repositoryOwnerUrl,
		'1.3.6.1.4.1.57264.1.17': input.repositoryOwnerId,
		'1.3.6.1.4.1.57264.1.18': workflowIdentity,
		'1.3.6.1.4.1.57264.1.19': input.commit,
		'1.3.6.1.4.1.57264.1.20': input.eventName,
		'1.3.6.1.4.1.57264.1.22': 'public',
		'1.3.6.1.4.1.57264.1.24': `repo:${input.repository}:ref:${input.sourceRef}`
	};
	return {
		workflowIdentity,
		verifyOptions: {
			certificateIssuer: GITHUB_OIDC_ISSUER,
			certificateIdentityURI: exactRegex(workflowIdentity),
			certificateOIDs: Object.fromEntries(
				Object.entries(values).map(([oid, value]) => [oid, derUtf8String(value)])
			)
		}
	};
}

// Fulcio v2 GitHub claims are DER UTF8String values inside their X.509
// extension octets. sigstore-js exposes the raw extension bytes to OID policy.
function derUtf8String(value: string): string {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.byteLength >= 128) {
		throw generic('release provenance certificate policy value exceeds its short-form DER limit');
	}
	return String.fromCharCode(0x0c, bytes.byteLength, ...bytes);
}

function exactRegex(value: string): string {
	return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function isTrustRootUnavailable(error: unknown): boolean {
	if (error instanceof TUFError) return true;
	if (!(error instanceof Error)) return false;
	return /(?:fetch|network|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN)/i.test(error.message);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
