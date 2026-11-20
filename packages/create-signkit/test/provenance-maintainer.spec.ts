import type { Bundle, VerifyOptions } from 'sigstore';
import { compress } from 'snappyjs';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedRelease } from '../src/release/github.js';
import {
	GITHUB_ACCOUNT_OIDC_ISSUER,
	MAINTAINER_SIGNERS,
	type MaintainerSigner
} from '../src/release/maintainer-signers.js';
import {
	MAINTAINER_BUILD_TYPE,
	createMaintainerReleaseStatement
} from '../src/release/maintainer-statement.js';
import {
	createGithubProvenanceVerifier,
	verifyMaintainerReleaseBundle,
	type ProvenanceVerifierOptions,
	type SigstoreBundleVerifier
} from '../src/release/provenance.js';
import { COMMIT, FakeHttp, sampleManifest } from './helpers.js';

const REPOSITORY_ID = 1365209252;
const BLOB_URL =
	'https://tmaproduction.blob.core.windows.net/attestations/1365209252/2026/11/20/654321.json.sn?sv=signed-value';
const MAINTAINER_EMAIL = 'maintainer@example.com';
const SIGNERS: readonly MaintainerSigner[] = [
	{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: MAINTAINER_EMAIL }
];
const OPTIONS: ProvenanceVerifierOptions = { maintainerSigners: SIGNERS };

type Statement = Record<string, unknown> & {
	subject: Array<{ name: string; digest: { sha256: string } }>;
	predicate: {
		buildDefinition: Record<string, unknown> & { externalParameters: Record<string, unknown> };
	};
};

describe('maintainer-signed release provenance', () => {
	it.each([
		{ tag: 'v1.2.3', channel: 'stable' as const },
		{ tag: 'v1.2.3-beta.1', channel: 'beta' as const }
	])(
		'accepts a pinned GitHub account signature for $channel releases',
		async ({ tag, channel }) => {
			const release = resolvedRelease(tag, channel);
			const http = configuredHttp(release, [maintainerStatement(release)]);
			const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);

			const result = await createGithubProvenanceVerifier(http, verifyBundle, OPTIONS).verify(
				release,
				release.manifest.bundle.sha256
			);

			expect(result).toEqual({
				status: 'verified',
				mode: 'online',
				kind: 'maintainer',
				repository: 'd6e-ai/signkit',
				signerIssuer: 'https://github.com/login/oauth',
				sourceRef: `refs/tags/${tag}`,
				sourceCommit: COMMIT,
				subjectName: release.manifest.bundle.assetName,
				subjectSha256: release.manifest.bundle.sha256,
				predicateType: 'https://slsa.dev/provenance/v1',
				buildType: 'https://github.com/d6e-ai/signkit/release/maintainer/v1',
				attestationCount: 1,
				trustRoot: 'sigstore-public-good'
			});
			expect(JSON.stringify(result)).not.toContain(MAINTAINER_EMAIL);
			expect(verifyBundle).toHaveBeenCalledOnce();
			const options = verifyBundle.mock.calls[0]![1];
			expect(options).toMatchObject({
				certificateIssuer: 'https://github.com/login/oauth',
				certificateIdentityEmail: '^(?:maintainer@example\\.com)$',
				ctLogThreshold: 1,
				tlogThreshold: 1,
				tufForceCache: false
			});
			expect(options.certificateIdentityURI).toBeUndefined();
			expect(options.certificateOIDs).toBeUndefined();
		}
	);

	it('accepts any one of several pinned maintainers and repeated signatures', async () => {
		const release = resolvedRelease();
		const signers: MaintainerSigner[] = [
			{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: 'first@example.com' },
			{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: MAINTAINER_EMAIL }
		];
		const http = configuredHttp(release, [
			maintainerStatement(release),
			maintainerStatement(release)
		]);
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, { maintainerSigners: signers }).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({ kind: 'maintainer', attestationCount: 2 });
		expect(verifyBundle.mock.calls[0]![1].certificateIdentityEmail).toBe(
			'^(?:first@example\\.com|maintainer@example\\.com)$'
		);
	});

	it('rejects a certificate from another OIDC issuer', async () => {
		const release = resolvedRelease();
		for (const issuer of [
			'https://accounts.google.com',
			'https://token.actions.githubusercontent.com',
			'https://github.com/login/oauth/'
		]) {
			const http = configuredHttp(release, [maintainerStatement(release)]);
			await expect(
				createGithubProvenanceVerifier(
					http,
					sigstoreWithCertificate(issuer, MAINTAINER_EMAIL),
					OPTIONS
				).verify(release, release.manifest.bundle.sha256),
				issuer
			).rejects.toThrow(/maintainer release provenance signature or signer identity is invalid/);
		}
	});

	it('rejects unlisted and look-alike signer emails', async () => {
		const release = resolvedRelease();
		for (const email of [
			'other@example.com',
			'MAINTAINER@example.com',
			'maintainer@exampleXcom',
			'maintainer@example.com.attacker.test',
			'evil-maintainer@example.com'
		]) {
			const http = configuredHttp(release, [maintainerStatement(release)]);
			await expect(
				createGithubProvenanceVerifier(
					http,
					sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, email),
					OPTIONS
				).verify(release, release.manifest.bundle.sha256),
				email
			).rejects.toThrow(/signature or signer identity is invalid/);
		}
	});

	it('re-checks the verified identity exactly instead of trusting the policy alone', async () => {
		const release = resolvedRelease();
		for (const signer of [
			{},
			{
				identity: {
					subjectAlternativeName: 'other@example.com',
					extensions: { issuer: GITHUB_ACCOUNT_OIDC_ISSUER }
				}
			},
			{
				identity: {
					subjectAlternativeName: MAINTAINER_EMAIL,
					extensions: { issuer: 'https://accounts.google.com' }
				}
			}
		]) {
			const http = configuredHttp(release, [maintainerStatement(release)]);
			await expect(
				createGithubProvenanceVerifier(http, async () => signer, OPTIONS).verify(
					release,
					release.manifest.bundle.sha256
				)
			).rejects.toThrow(/signer is not a pinned maintainer/);
		}
	});

	it('fails closed when no maintainer is pinned', async () => {
		const release = resolvedRelease();
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		const http = configuredHttp(release, [maintainerStatement(release)]);
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, { maintainerSigners: [] }).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/pins no maintainer signers/);
		await expect(
			verifyMaintainerReleaseBundle(
				signedBundle(maintainerStatement(release)),
				release,
				release.manifest.bundle.sha256,
				{ verifyBundle, maintainerSigners: [] }
			)
		).rejects.toThrow(/pins no maintainer signers/);
		expect(verifyBundle).not.toHaveBeenCalled();
	});

	it('rejects a malformed pinned signer list', async () => {
		const release = resolvedRelease();
		const malformed = [
			[{ issuer: 'https://accounts.google.com', email: MAINTAINER_EMAIL }],
			[{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: 'not-an-email' }],
			[{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: ' maintainer@example.com' }],
			[...SIGNERS, ...SIGNERS]
		] as unknown as Array<readonly MaintainerSigner[]>;
		for (const maintainerSigners of malformed) {
			const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
			const http = configuredHttp(release, [maintainerStatement(release)]);
			await expect(
				createGithubProvenanceVerifier(http, verifyBundle, { maintainerSigners }).verify(
					release,
					release.manifest.bundle.sha256
				)
			).rejects.toThrow(/signer list is malformed/);
			expect(verifyBundle).not.toHaveBeenCalled();
		}
	});

	it('ships a frozen, well-formed signer list', () => {
		expect(Object.isFrozen(MAINTAINER_SIGNERS)).toBe(true);
		const emails = new Set<string>();
		for (const signer of MAINTAINER_SIGNERS) {
			expect(signer.issuer).toBe('https://github.com/login/oauth');
			expect(signer.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
			expect(emails.has(signer.email)).toBe(false);
			emails.add(signer.email);
		}
	});

	it('uses the shipped signer list by default', async () => {
		const release = resolvedRelease();
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		const http = configuredHttp(release, [maintainerStatement(release)]);
		const outcome = createGithubProvenanceVerifier(http, verifyBundle).verify(
			release,
			release.manifest.bundle.sha256
		);
		if (MAINTAINER_SIGNERS.length === 0) {
			await expect(outcome).rejects.toThrow(/pins no maintainer signers/);
		} else {
			await expect(outcome).rejects.toThrow(/signature or signer identity is invalid/);
			expect(verifyBundle.mock.calls[0]![1].certificateIssuer).toBe(GITHUB_ACCOUNT_OIDC_ISSUER);
		}
	});

	it('rejects every mismatched signed statement claim', async () => {
		const release = resolvedRelease();
		const mutations: Array<[string, (statement: Statement) => void, RegExp]> = [
			[
				'subject digest',
				(s) => (bundleSubject(s).digest.sha256 = 'f'.repeat(64)),
				/matching bundle subject/
			],
			[
				'subject name',
				(s) => (bundleSubject(s).name = 'signkit-cloudflare-v9.9.9.tar.gz'),
				/matching bundle subject/
			],
			[
				'duplicate subject',
				(s) => s.subject.push(structuredClone(bundleSubject(s))),
				/matching bundle subject/
			],
			['malformed subject', (s) => (s.subject[1]!.digest.sha256 = 'not-hex'), /malformed subject/],
			[
				'tag',
				(s) => (s.predicate.buildDefinition.externalParameters.ref = 'refs/tags/v9.9.9'),
				/repository, tag, or commit/
			],
			[
				'branch ref',
				(s) => (s.predicate.buildDefinition.externalParameters.ref = 'refs/heads/main'),
				/repository, tag, or commit/
			],
			[
				'commit',
				(s) => (s.predicate.buildDefinition.externalParameters.commit = 'f'.repeat(40)),
				/repository, tag, or commit/
			],
			[
				'repository',
				(s) =>
					(s.predicate.buildDefinition.externalParameters.repository =
						'https://github.com/evil/signkit'),
				/repository, tag, or commit/
			],
			[
				'extra parameter',
				(s) => (s.predicate.buildDefinition.externalParameters.workflow = 'x'),
				/repository, tag, or commit/
			],
			[
				'missing parameter',
				(s) => delete s.predicate.buildDefinition.externalParameters.commit,
				/repository, tag, or commit/
			],
			[
				'predicate type',
				(s) => (s.predicateType = 'https://example.test/predicate'),
				/predicate type/
			],
			[
				'statement type',
				(s) => (s._type = 'https://in-toto.io/Statement/v0.1'),
				/in-toto Statement v1/
			]
		];
		for (const [name, mutate, message] of mutations) {
			const statement = maintainerStatement(release);
			mutate(statement);
			const http = configuredHttp(release, [statement]);
			await expect(
				createGithubProvenanceVerifier(
					http,
					sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL),
					OPTIONS
				).verify(release, release.manifest.bundle.sha256),
				name
			).rejects.toThrow(message);
		}
	});

	it('rejects unknown build types on both the online and local paths', async () => {
		const release = resolvedRelease();
		for (const buildType of [
			'https://github.com/d6e-ai/signkit/release/maintainer/v2',
			'https://example.test/build'
		]) {
			const statement = maintainerStatement(release);
			statement.predicate.buildDefinition.buildType = buildType;
			const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
			await expect(
				createGithubProvenanceVerifier(
					configuredHttp(release, [statement]),
					verifyBundle,
					OPTIONS
				).verify(release, release.manifest.bundle.sha256),
				buildType
			).rejects.toThrow();
			await expect(
				verifyMaintainerReleaseBundle(
					signedBundle(statement),
					release,
					release.manifest.bundle.sha256,
					{
						...OPTIONS,
						verifyBundle
					}
				)
			).rejects.toThrow(/not the maintainer release type/);
		}
	});

	it('rejects a replaced bundle whose digest the signed statement does not name', async () => {
		const original = resolvedRelease();
		const replacementDigest = 'e'.repeat(64);
		const replaced: ResolvedRelease = {
			...original,
			manifest: {
				...original.manifest,
				bundle: { ...original.manifest.bundle, sha256: replacementDigest }
			}
		};
		const http = configuredHttp(replaced, [maintainerStatement(original)]);
		await expect(
			createGithubProvenanceVerifier(
				http,
				sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL),
				OPTIONS
			).verify(replaced, replacementDigest)
		).rejects.toThrow(/matching bundle subject/);
		await expect(
			verifyMaintainerReleaseBundle(
				signedBundle(maintainerStatement(original)),
				original,
				replacementDigest,
				OPTIONS
			)
		).rejects.toThrow(/does not match the downloaded bundle/);
	});

	it('maps signature failures and an unavailable trust root like the workflow path', async () => {
		const release = resolvedRelease();
		await expect(
			createGithubProvenanceVerifier(
				configuredHttp(release, [maintainerStatement(release)]),
				async () => {
					throw new Error('bad signature');
				},
				OPTIONS
			).verify(release, release.manifest.bundle.sha256)
		).rejects.toMatchObject({ exitCode: 1 });
		await expect(
			createGithubProvenanceVerifier(
				configuredHttp(release, [maintainerStatement(release)]),
				async () => {
					throw new Error('network timeout');
				},
				OPTIONS
			).verify(release, release.manifest.bundle.sha256)
		).rejects.toMatchObject({ code: 'unavailable', exitCode: 5 });
	});

	it('still accepts workflow provenance and refuses to mix the two kinds', async () => {
		const release = resolvedRelease();
		const workflowHttp = configuredHttp(release, [workflowStatement(release)]);
		const workflowVerifier = vi.fn<SigstoreBundleVerifier>(async () => ({}));
		await expect(
			createGithubProvenanceVerifier(workflowHttp, workflowVerifier, OPTIONS).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({
			kind: 'workflow',
			workflow: '.github/workflows/release-cloudflare-bundle.yml',
			sourceRef: `refs/tags/${release.tag}`
		});
		expect(workflowVerifier.mock.calls[0]![1]).toMatchObject({
			certificateIssuer: 'https://token.actions.githubusercontent.com'
		});

		for (const statements of [
			[workflowStatement(release), maintainerStatement(release)],
			[maintainerStatement(release), workflowStatement(release)]
		]) {
			const mixedHttp = configuredHttp(release, statements);
			await expect(
				createGithubProvenanceVerifier(
					mixedHttp,
					async () => ({
						identity: {
							subjectAlternativeName: MAINTAINER_EMAIL,
							extensions: { issuer: GITHUB_ACCOUNT_OIDC_ISSUER }
						}
					}),
					OPTIONS
				).verify(release, release.manifest.bundle.sha256)
			).rejects.toThrow(/mixes workflow and maintainer attestations/);
		}
	});

	it('verifies a local bundle with the same policy as the online path', async () => {
		const release = resolvedRelease();
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		await expect(
			verifyMaintainerReleaseBundle(
				signedBundle(maintainerStatement(release)),
				release,
				release.manifest.bundle.sha256,
				{ ...OPTIONS, verifyBundle }
			)
		).resolves.toMatchObject({ kind: 'maintainer', attestationCount: 1 });
		expect(verifyBundle.mock.calls[0]![1].certificateIdentityEmail).toBe(
			'^(?:maintainer@example\\.com)$'
		);
	});
});

describe('maintainer release statement', () => {
	it('names every asset and binds repository, tag, and commit', () => {
		const statement = createMaintainerReleaseStatement({
			tag: 'v1.2.3',
			commit: COMMIT,
			subjects: [
				{ name: 'signkit-node-v1.2.3.tar.gz', sha256: 'b'.repeat(64) },
				{ name: 'SHA256SUMS', sha256: 'a'.repeat(64) }
			],
			internalParameters: { node: 'v24.0.0' },
			startedOn: '2026-11-20T00:00:00.000Z'
		});
		expect(statement).toEqual({
			_type: 'https://in-toto.io/Statement/v1',
			subject: [
				{ name: 'SHA256SUMS', digest: { sha256: 'a'.repeat(64) } },
				{ name: 'signkit-node-v1.2.3.tar.gz', digest: { sha256: 'b'.repeat(64) } }
			],
			predicateType: 'https://slsa.dev/provenance/v1',
			predicate: {
				buildDefinition: {
					buildType: MAINTAINER_BUILD_TYPE,
					externalParameters: {
						repository: 'https://github.com/d6e-ai/signkit',
						ref: 'refs/tags/v1.2.3',
						commit: COMMIT
					},
					internalParameters: { node: 'v24.0.0' }
				},
				runDetails: {
					builder: {
						id: `https://github.com/d6e-ai/signkit/blob/${COMMIT}/scripts/release-local.mjs`
					},
					metadata: { startedOn: '2026-11-20T00:00:00.000Z' }
				}
			}
		});
	});

	it('rejects invalid tags, commits, and subjects', () => {
		const subjects = [{ name: 'a.tar.gz', sha256: 'a'.repeat(64) }];
		const bad: Array<Parameters<typeof createMaintainerReleaseStatement>[0]> = [
			{ tag: '1.2.3', commit: COMMIT, subjects },
			{ tag: 'v1.2.3+build.1', commit: COMMIT, subjects },
			{ tag: ' v1.2.3', commit: COMMIT, subjects },
			{ tag: 'v1.2.3', commit: COMMIT.toUpperCase(), subjects },
			{ tag: 'v1.2.3', commit: COMMIT.slice(1), subjects },
			{ tag: 'v1.2.3', commit: COMMIT, subjects: [] },
			{ tag: 'v1.2.3', commit: COMMIT, subjects: [...subjects, ...subjects] },
			{ tag: 'v1.2.3', commit: COMMIT, subjects: [{ name: 'a.tar.gz', sha256: 'A'.repeat(64) }] },
			{
				tag: 'v1.2.3',
				commit: COMMIT,
				subjects: [{ name: 'dir/a.tar.gz', sha256: 'a'.repeat(64) }]
			}
		];
		for (const input of bad) {
			expect(() => createMaintainerReleaseStatement(input), JSON.stringify(input)).toThrow();
		}
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

function maintainerStatement(release: ResolvedRelease): Statement {
	return structuredClone(
		createMaintainerReleaseStatement({
			tag: release.tag,
			commit: release.commit as string,
			subjects: [
				{ name: 'SHA256SUMS', sha256: 'c'.repeat(64) },
				{ name: release.manifest.bundle.assetName, sha256: release.manifest.bundle.sha256 },
				{ name: 'signkit-cloudflare-manifest.json', sha256: 'd'.repeat(64) }
			]
		})
	) as unknown as Statement;
}

function bundleSubject(statement: Statement): Statement['subject'][number] {
	const subject = statement.subject.find((entry) => entry.name.startsWith('signkit-cloudflare-v'));
	if (!subject) throw new Error('fixture statement has no bundle subject');
	return subject;
}

function workflowStatement(release: ResolvedRelease): Record<string, unknown> {
	const sourceRef = `refs/tags/${release.tag}`;
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
						event_name: 'push',
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
			runDetails: {
				builder: {
					id: `https://github.com/d6e-ai/signkit/.github/workflows/release-cloudflare-bundle.yml@${sourceRef}`
				}
			}
		}
	};
}

// Emulates sigstore-js policy matching for one Fulcio certificate: the issuer
// extension is compared exactly and the identity is an unanchored regex.
function sigstoreWithCertificate(issuer: string, email: string) {
	return vi.fn(async (_bundle: Bundle, options: VerifyOptions) => {
		if (options.certificateIssuer !== undefined && options.certificateIssuer !== issuer) {
			throw new Error('invalid certificate extension');
		}
		const identityPolicy = options.certificateIdentityEmail ?? options.certificateIdentityURI;
		if (identityPolicy !== undefined && !email.match(identityPolicy)) {
			throw new Error('certificate identity error');
		}
		return { identity: { subjectAlternativeName: email, extensions: { issuer } } };
	});
}

function signedBundle(statement: unknown): Bundle {
	return {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		dsseEnvelope: {
			payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
			payloadType: 'application/vnd.in-toto+json',
			signatures: [{ sig: 'fixture-signature', keyid: '' }]
		},
		verificationMaterial: {}
	} as unknown as Bundle;
}

function configuredHttp(release: ResolvedRelease, statements: unknown[]): FakeHttp {
	const http = new FakeHttp();
	const urls = statements.map((_, index) =>
		BLOB_URL.replace('654321.json.sn', `${654321 + index}.json.sn`)
	);
	http.on(
		`https://api.github.com/repos/d6e-ai/signkit/attestations/sha256:${release.manifest.bundle.sha256}?predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1&per_page=10`,
		{ attestations: urls.map((bundle_url) => ({ bundle_url, repository_id: REPOSITORY_ID })) }
	);
	for (let index = 0; index < statements.length; index += 1) {
		http.on(
			urls[index]!,
			compress(new TextEncoder().encode(JSON.stringify(signedBundle(statements[index]))))
		);
	}
	return http;
}
