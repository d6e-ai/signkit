import { compress } from 'snappyjs';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedRelease } from '../src/release/github.js';
import { createGithubProvenanceVerifier } from '../src/release/provenance.js';
import { COMMIT, FakeHttp, sampleManifest } from './helpers.js';

const REPOSITORY_ID = 1365209252;
const BLOB_URL =
	'https://tmaproduction.blob.core.windows.net/attestations/1365209252/2026/09/16/123456.json.sn?sv=signed-value';

describe('GitHub release provenance', () => {
	it.each([
		{ tag: 'v1.2.3', channel: 'stable' as const },
		{ tag: 'v1.2.3-beta.1', channel: 'beta' as const }
	])('verifies mandatory online provenance for $channel releases', async ({ tag, channel }) => {
		const release = resolvedRelease(tag, channel);
		const http = configuredHttp(release, [statementFor(release)]);
		const verifyBundle = vi.fn(async () => ({}));
		const result = await createGithubProvenanceVerifier(http, verifyBundle).verify(
			release,
			release.manifest.bundle.sha256
		);

		expect(result).toMatchObject({
			status: 'verified',
			mode: 'online',
			repository: 'd6e-ai/signkit',
			workflow: '.github/workflows/release-cloudflare-bundle.yml',
			sourceRef: `refs/tags/${tag}`,
			sourceCommit: COMMIT,
			subjectName: release.manifest.bundle.assetName,
			subjectSha256: release.manifest.bundle.sha256,
			attestationCount: 1,
			trustRoot: 'sigstore-public-good'
		});
		expect(verifyBundle).toHaveBeenCalledOnce();
		const options = verifyBundle.mock.calls[0]![1];
		expect(options).toMatchObject({
			certificateIssuer: 'https://token.actions.githubusercontent.com',
			ctLogThreshold: 1,
			tlogThreshold: 1,
			tufForceCache: false
		});
		expect(options.certificateIdentityURI).toContain(
			`release-cloudflare-bundle\\.yml@refs/tags/${tag.replaceAll('.', '\\.')}`
		);
		expect(options.certificateOIDs?.['1.3.6.1.4.1.57264.1.24']).toBe(
			derUtf8String(`repo:d6e-ai@251581364/signkit@1365209252:ref:refs/tags/${tag}`)
		);
		expect(http.requests[0]?.url).toContain(
			'predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1'
		);
	});

	it('verifies the normal workflow-dispatch release path from main', async () => {
		const release = resolvedRelease();
		const statement = statementFor(release, {
			sourceRef: 'refs/heads/main',
			eventName: 'workflow_dispatch'
		});
		const http = configuredHttp(release, [statement]);
		const verifyBundle = vi.fn(async () => ({}));

		await expect(
			createGithubProvenanceVerifier(http, verifyBundle).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({ sourceRef: 'refs/heads/main', sourceCommit: COMMIT });

		const options = verifyBundle.mock.calls[0]![1];
		expect(options.certificateIdentityURI).toContain(
			'release-cloudflare-bundle\\.yml@refs/heads/main'
		);
		expect(options.certificateOIDs?.['1.3.6.1.4.1.57264.1.20']).toBe(
			derUtf8String('workflow_dispatch')
		);
	});

	it.each([
		{ sourceRef: 'refs/heads/feature', eventName: 'workflow_dispatch' as const },
		{ sourceRef: 'refs/heads/main', eventName: 'push' as const },
		{ sourceRef: 'refs/tags/v1.2.3', eventName: 'workflow_dispatch' as const }
	])('rejects disallowed release source $sourceRef for $eventName', async (source) => {
		const release = resolvedRelease();
		const http = configuredHttp(release, [statementFor(release, source)]);
		await expect(
			createGithubProvenanceVerifier(http, async () => ({})).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/event or workflow source ref is not allowed/);
	});

	it('accepts the maximum release tag and rejects the first oversized tag before lookup', async () => {
		const tag = `v1.2.3-${'a'.repeat(28)}`;
		const release = resolvedRelease(tag, 'beta');
		const http = configuredHttp(release, [statementFor(release)]);
		const verifyBundle = vi.fn(async () => ({}));

		await createGithubProvenanceVerifier(http, verifyBundle).verify(
			release,
			release.manifest.bundle.sha256
		);

		const encoded = verifyBundle.mock.calls[0]![1].certificateOIDs?.['1.3.6.1.4.1.57264.1.9'];
		expect(encoded?.charCodeAt(0)).toBe(0x0c);
		expect(encoded?.charCodeAt(1)).toBe(127);

		const oversized = resolvedRelease(`v1.2.3-${'a'.repeat(29)}`, 'beta');
		const untouchedHttp = configuredHttp(oversized, [statementFor(oversized)]);
		await expect(
			createGithubProvenanceVerifier(untouchedHttp, verifyBundle).verify(
				oversized,
				oversized.manifest.bundle.sha256
			)
		).rejects.toThrow(/short-form DER limit/);
		expect(untouchedHttp.requests).toEqual([]);
	});

	it('rejects missing, unavailable, malformed, and oversized attestations', async () => {
		const release = resolvedRelease();
		const digest = release.manifest.bundle.sha256;
		const apiUrl = attestationApiUrl(digest);

		const missing = new FakeHttp();
		missing.on(apiUrl, { attestations: [] });
		await expect(
			createGithubProvenanceVerifier(missing, async () => ({})).verify(release, digest)
		).rejects.toThrow(/provenance is missing/);

		const unavailable = new FakeHttp();
		unavailable.on(apiUrl, {}, 503);
		await expect(
			createGithubProvenanceVerifier(unavailable, async () => ({})).verify(release, digest)
		).rejects.toMatchObject({ code: 'unavailable', exitCode: 5 });

		const malformed = new FakeHttp();
		malformed.on(apiUrl, {
			attestations: [{ bundle_url: BLOB_URL, repository_id: REPOSITORY_ID }]
		});
		malformed.on(BLOB_URL, new Uint8Array([0xff, 0xff, 0xff]));
		await expect(
			createGithubProvenanceVerifier(malformed, async () => ({})).verify(release, digest)
		).rejects.toThrow(/malformed|decoded size limit/);

		const oversized = new FakeHttp();
		oversized.on(apiUrl, {
			attestations: [{ bundle_url: BLOB_URL, repository_id: REPOSITORY_ID }]
		});
		oversized.on(
			BLOB_URL,
			compress(new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) })))
		);
		await expect(
			createGithubProvenanceVerifier(oversized, async () => ({})).verify(release, digest)
		).rejects.toThrow(/decoded size limit/);
	});

	it('rejects an untrusted bundle URL without disclosing its signed query', async () => {
		const release = resolvedRelease();
		const http = new FakeHttp();
		http.on(attestationApiUrl(release.manifest.bundle.sha256), {
			attestations: [
				{
					bundle_url: 'https://evil.example/attestations/secret.json.sn?sig=do-not-print',
					repository_id: REPOSITORY_ID
				}
			]
		});
		await expect(
			createGithubProvenanceVerifier(http, async () => ({})).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toSatisfy((error: Error) => {
			expect(error.message).toMatch(/not an allowed/);
			expect(error.message).not.toContain('do-not-print');
			return true;
		});
	});

	it('rejects invalid signatures and every mismatched signed claim', async () => {
		const release = resolvedRelease();
		const invalidSignatureHttp = configuredHttp(release, [statementFor(release)]);
		await expect(
			createGithubProvenanceVerifier(invalidSignatureHttp, async () => {
				throw new Error('bad signature');
			}).verify(release, release.manifest.bundle.sha256)
		).rejects.toThrow(/signature or signer identity is invalid/);

		const mutations: Array<[string, (statement: ReturnType<typeof statementFor>) => void]> = [
			[
				'repository',
				(statement) =>
					(statement.predicate.buildDefinition.externalParameters.workflow.repository =
						'https://github.com/evil/repo')
			],
			[
				'workflow',
				(statement) =>
					(statement.predicate.buildDefinition.externalParameters.workflow.path =
						'.github/workflows/evil.yml')
			],
			[
				'ref',
				(statement) =>
					(statement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v9.9.9')
			],
			[
				'commit',
				(statement) =>
					(statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
						'f'.repeat(40))
			],
			['subject name', (statement) => (statement.subject[0]!.name = 'other.tar.gz')],
			['subject digest', (statement) => (statement.subject[0]!.digest.sha256 = 'f'.repeat(64))],
			['predicate', (statement) => (statement.predicateType = 'https://example.test/predicate')],
			[
				'build type',
				(statement) =>
					(statement.predicate.buildDefinition.buildType = 'https://example.test/build')
			],
			[
				'repository id',
				(statement) =>
					(statement.predicate.buildDefinition.internalParameters.github.repository_id = '1')
			],
			[
				'builder',
				(statement) => (statement.predicate.runDetails.builder.id = 'https://github.com/evil/repo')
			]
		];
		for (const [name, mutate] of mutations) {
			const statement = statementFor(release);
			mutate(statement);
			const http = configuredHttp(release, [statement]);
			await expect(
				createGithubProvenanceVerifier(http, async () => ({})).verify(
					release,
					release.manifest.bundle.sha256
				),
				name
			).rejects.toThrow();
		}
	});

	it('accepts byte-identical rerun attestations but rejects conflicting or duplicate subjects', async () => {
		const release = resolvedRelease();
		const valid = statementFor(release);
		const identical = structuredClone(valid);
		const rerunHttp = configuredHttp(release, [valid, identical]);
		await expect(
			createGithubProvenanceVerifier(rerunHttp, async () => ({})).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({ attestationCount: 2 });

		const conflict = statementFor(release);
		conflict.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/tags/v9.9.9';
		const conflictHttp = configuredHttp(release, [statementFor(release), conflict]);
		await expect(
			createGithubProvenanceVerifier(conflictHttp, async () => ({})).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/event or workflow source ref/);

		const duplicate = statementFor(release);
		duplicate.subject.push(structuredClone(duplicate.subject[0]!));
		const duplicateHttp = configuredHttp(release, [duplicate]);
		await expect(
			createGithubProvenanceVerifier(duplicateHttp, async () => ({})).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/exactly one matching bundle subject/);
	});

	it('rejects a replaced bundle and matching mutable manifest without matching signed provenance', async () => {
		const original = resolvedRelease();
		const replacementDigest = 'f'.repeat(64);
		const replaced: ResolvedRelease = {
			...original,
			manifest: {
				...original.manifest,
				bundle: { ...original.manifest.bundle, sha256: replacementDigest }
			}
		};
		const oldStatement = statementFor(original);
		const http = configuredHttp(replaced, [oldStatement]);
		await expect(
			createGithubProvenanceVerifier(http, async () => ({})).verify(replaced, replacementDigest)
		).rejects.toThrow(/matching bundle subject/);
	});
});

function resolvedRelease(tag = 'v1.2.3', channel: 'stable' | 'beta' = 'stable'): ResolvedRelease {
	const manifest = sampleManifest({
		tag,
		channel,
		bundle: {
			...sampleManifest().bundle,
			assetName: `signkit-cloudflare-${tag}.tar.gz`
		}
	});
	return {
		tag,
		channel,
		prerelease: channel === 'beta',
		commit: COMMIT,
		manifest,
		manifestUrl: `https://github.com/d6e-ai/signkit/releases/download/${tag}/signkit-cloudflare-manifest.json`,
		bundleUrl: `https://github.com/d6e-ai/signkit/releases/download/${tag}/${manifest.bundle.assetName}`
	};
}

function statementFor(
	release: ResolvedRelease,
	source: { sourceRef: string; eventName: 'push' | 'workflow_dispatch' } = {
		sourceRef: `refs/tags/${release.tag}`,
		eventName: 'push'
	}
) {
	const { sourceRef, eventName } = source;
	const workflowIdentity = `https://github.com/d6e-ai/signkit/.github/workflows/release-cloudflare-bundle.yml@${sourceRef}`;
	return {
		_type: 'https://in-toto.io/Statement/v1',
		subject: [
			{
				name: release.manifest.bundle.assetName,
				digest: { sha256: release.manifest.bundle.sha256 }
			}
		],
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: {
			buildDefinition: {
				buildType: 'https://actions.github.io/buildtypes/workflow/v1',
				externalParameters: {
					workflow: {
						ref: sourceRef,
						repository: 'https://github.com/d6e-ai/signkit',
						path: '.github/workflows/release-cloudflare-bundle.yml'
					}
				},
				internalParameters: {
					github: {
						event_name: eventName,
						repository_id: String(REPOSITORY_ID),
						repository_owner_id: '251581364',
						runner_environment: 'github-hosted'
					}
				},
				resolvedDependencies: [
					{
						uri: `git+https://github.com/d6e-ai/signkit@${sourceRef}`,
						digest: { gitCommit: release.commit as string }
					}
				]
			},
			runDetails: { builder: { id: workflowIdentity } }
		}
	};
}

function configuredHttp(
	release: ResolvedRelease,
	statements: Array<ReturnType<typeof statementFor>>
): FakeHttp {
	const http = new FakeHttp();
	const urls = statements.map((_, index) =>
		BLOB_URL.replace('123456.json.sn', `${123456 + index}.json.sn`)
	);
	http.on(attestationApiUrl(release.manifest.bundle.sha256), {
		attestations: urls.map((bundle_url) => ({ bundle_url, repository_id: REPOSITORY_ID }))
	});
	for (let index = 0; index < statements.length; index += 1) {
		http.on(urls[index]!, encodedBundle(statements[index]!));
	}
	return http;
}

function encodedBundle(statement: ReturnType<typeof statementFor>): Uint8Array {
	return compress(
		new TextEncoder().encode(
			JSON.stringify({
				mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
				dsseEnvelope: {
					payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
					payloadType: 'application/vnd.in-toto+json',
					signatures: [{ sig: 'fixture-signature' }]
				},
				verificationMaterial: {}
			})
		)
	);
}

function attestationApiUrl(digest: string): string {
	return `https://api.github.com/repos/d6e-ai/signkit/attestations/sha256:${digest}?predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1&per_page=10`;
}

function derUtf8String(value: string): string {
	const bytes = Buffer.from(value, 'utf8');
	return String.fromCharCode(0x0c, bytes.byteLength, ...bytes);
}
