import type { Bundle, VerifyOptions } from 'sigstore';
import { compress } from 'snappyjs';
import { describe, expect, it, vi } from 'vitest';
import {
	createGithubReleaseResolver,
	sha256Hex,
	type ResolvedRelease
} from '../src/release/github.js';
import {
	GITHUB_ACCOUNT_OIDC_ISSUER,
	MAINTAINER_SIGNERS,
	type MaintainerSigner
} from '../src/release/maintainer-signers.js';
import {
	MAINTAINER_BUILD_TYPE,
	MAX_MAINTAINER_SIGNATURE_BYTES,
	createMaintainerReleaseStatement,
	maintainerSignatureAssetName
} from '../src/release/maintainer-statement.js';
import {
	createGithubProvenanceVerifier,
	verifyMaintainerReleaseBundle,
	type ProvenanceVerifierOptions,
	type SigstoreBundleVerifier
} from '../src/release/provenance.js';
import {
	COMMIT,
	FakeHttp,
	githubReleaseJson,
	sampleBundleBytes,
	sampleManifest
} from './helpers.js';

const REPOSITORY_ID = 1365209252;
const API = 'https://api.github.com/repos/d6e-ai/signkit';
const DL = 'https://github.com/d6e-ai/signkit/releases/download';
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

describe('maintainer signature release asset', () => {
	it.each([
		{ tag: 'v1.2.3', channel: 'stable' as const },
		{ tag: 'v1.2.3-beta.1', channel: 'beta' as const }
	])(
		'accepts a pinned GitHub account signature for $channel releases',
		async ({ tag, channel }) => {
			const { release, http } = maintainerRelease(
				maintainerStatement(baseRelease(tag, channel)),
				baseRelease(tag, channel)
			);
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
				signatureAsset: `signkit-provenance-${tag}.sigstore.json`,
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
			// The GitHub attestations lookup still runs first, and the asset comes
			// from the release download URL under the same host and size rules.
			expect(http.requests[0]?.url).toContain(`${API}/attestations/sha256:`);
			const assetRequest = http.requests[1]!;
			expect(assetRequest.url).toBe(`${DL}/${tag}/signkit-provenance-${tag}.sigstore.json`);
			expect(assetRequest.maxBytes).toBe(release.maintainerSignature!.size);
			expect([...assetRequest.allowedHosts]).toContain('github.com');
			expect([...assetRequest.allowedHosts]).not.toContain('tmaproduction.blob.core.windows.net');
		}
	);

	it('accepts any one of several pinned maintainers', async () => {
		const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
		const signers: MaintainerSigner[] = [
			{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: 'first@example.com' },
			{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: MAINTAINER_EMAIL }
		];
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, { maintainerSigners: signers }).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({ kind: 'maintainer' });
		expect(verifyBundle.mock.calls[0]![1].certificateIdentityEmail).toBe(
			'^(?:first@example\\.com|maintainer@example\\.com)$'
		);
	});

	it('rejects a certificate from another OIDC issuer', async () => {
		for (const issuer of [
			'https://accounts.google.com',
			'https://token.actions.githubusercontent.com',
			'https://github.com/login/oauth/'
		]) {
			const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
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
		for (const email of [
			'other@example.com',
			'MAINTAINER@example.com',
			'maintainer@exampleXcom',
			'maintainer@example.com.attacker.test',
			'evil-maintainer@example.com'
		]) {
			const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
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
			const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
			await expect(
				createGithubProvenanceVerifier(http, async () => signer, OPTIONS).verify(
					release,
					release.manifest.bundle.sha256
				)
			).rejects.toThrow(/signer is not a pinned maintainer/);
		}
	});

	it('fails closed when no maintainer is pinned', async () => {
		const statement = maintainerStatement(baseRelease());
		const { release, http } = maintainerRelease(statement);
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, { maintainerSigners: [] }).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/pins no maintainer signers/);
		await expect(
			verifyMaintainerReleaseBundle(
				signedBundle(statement),
				release,
				release.manifest.bundle.sha256,
				{
					verifyBundle,
					maintainerSigners: []
				}
			)
		).rejects.toThrow(/pins no maintainer signers/);
		expect(verifyBundle).not.toHaveBeenCalled();
	});

	it('rejects a malformed pinned signer list', async () => {
		const malformed = [
			[{ issuer: 'https://accounts.google.com', email: MAINTAINER_EMAIL }],
			[{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: 'not-an-email' }],
			[{ issuer: GITHUB_ACCOUNT_OIDC_ISSUER, email: ' maintainer@example.com' }],
			[...SIGNERS, ...SIGNERS]
		] as unknown as Array<readonly MaintainerSigner[]>;
		for (const maintainerSigners of malformed) {
			const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
			const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
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
		const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
		const verifyBundle = sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL);
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
			],
			[
				'build type',
				(s) =>
					(s.predicate.buildDefinition.buildType =
						'https://github.com/d6e-ai/signkit/release/maintainer/v2'),
				/not the maintainer release type/
			]
		];
		for (const [name, mutate, message] of mutations) {
			const statement = maintainerStatement(baseRelease());
			mutate(statement);
			const { release, http } = maintainerRelease(statement);
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

	it('rejects a replaced bundle whose digest the signed statement does not name', async () => {
		const original = baseRelease();
		const replacementDigest = 'e'.repeat(64);
		const replaced: ResolvedRelease = {
			...original,
			manifest: {
				...original.manifest,
				bundle: { ...original.manifest.bundle, sha256: replacementDigest }
			}
		};
		const { release, http } = maintainerRelease(maintainerStatement(original), replaced);
		await expect(
			createGithubProvenanceVerifier(
				http,
				sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL),
				OPTIONS
			).verify(release, replacementDigest)
		).rejects.toThrow(/matching bundle subject/);
	});

	it('reports missing provenance when there is neither an attestation nor an asset', async () => {
		const release = baseRelease();
		const http = attestationHttp(release, []);
		await expect(
			createGithubProvenanceVerifier(http, async () => ({}), OPTIONS).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/GitHub release provenance is missing for the downloaded Cloudflare bundle/);
	});

	it('refuses a release that has both workflow attestations and a maintainer asset', async () => {
		const workflow = baseRelease();
		const { release, http } = maintainerRelease(maintainerStatement(workflow), workflow, [
			workflowStatement(workflow)
		]);
		const verifyBundle = vi.fn<SigstoreBundleVerifier>(async () => ({}));
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, OPTIONS).verify(
				release,
				release.manifest.bundle.sha256
			)
		).rejects.toThrow(/mixes GitHub workflow attestations and a maintainer signature asset/);
		expect(verifyBundle).not.toHaveBeenCalled();
		expect(http.requests.some((request) => request.url.endsWith('.sigstore.json'))).toBe(false);
	});

	it('keeps the workflow path unchanged when the release has no maintainer asset', async () => {
		const release = baseRelease();
		const http = attestationHttp(release, [workflowStatement(release)]);
		const verifyBundle = vi.fn<SigstoreBundleVerifier>(async () => ({}));
		await expect(
			createGithubProvenanceVerifier(http, verifyBundle, OPTIONS).verify(
				release,
				release.manifest.bundle.sha256
			)
		).resolves.toMatchObject({
			kind: 'workflow',
			workflow: '.github/workflows/release-cloudflare-bundle.yml',
			sourceRef: `refs/tags/${release.tag}`
		});
		expect(verifyBundle.mock.calls[0]![1]).toMatchObject({
			certificateIssuer: 'https://token.actions.githubusercontent.com'
		});
	});

	it('never accepts a maintainer statement through the GitHub attestations API', async () => {
		const release = baseRelease();
		const http = attestationHttp(release, [maintainerStatement(release)]);
		await expect(
			createGithubProvenanceVerifier(
				http,
				sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL),
				OPTIONS
			).verify(release, release.manifest.bundle.sha256)
		).rejects.toThrow(/event or workflow source ref is not allowed/);
	});

	it('bounds the asset size before and during the download', async () => {
		const statement = maintainerStatement(baseRelease());
		for (const size of [MAX_MAINTAINER_SIGNATURE_BYTES + 1, 0, -1, 1.5]) {
			const { release, http } = maintainerRelease(statement);
			release.maintainerSignature!.size = size;
			await expect(
				createGithubProvenanceVerifier(
					http,
					sigstoreWithCertificate(GITHUB_ACCOUNT_OIDC_ISSUER, MAINTAINER_EMAIL),
					OPTIONS
				).verify(release, release.manifest.bundle.sha256),
				String(size)
			).rejects.toThrow(/maintainer signature asset (size \d+ exceeds|has an invalid size)/);
			expect(http.requests.some((request) => request.url.endsWith('.sigstore.json'))).toBe(false);
		}

		const shorter = maintainerRelease(statement);
		shorter.release.maintainerSignature!.size -= 1;
		await expect(
			createGithubProvenanceVerifier(shorter.http, async () => ({}), OPTIONS).verify(
				shorter.release,
				shorter.release.manifest.bundle.sha256
			)
		).rejects.toThrow(/exceeded limit/);

		const longer = maintainerRelease(statement);
		longer.release.maintainerSignature!.size += 1;
		await expect(
			createGithubProvenanceVerifier(longer.http, async () => ({}), OPTIONS).verify(
				longer.release,
				longer.release.manifest.bundle.sha256
			)
		).rejects.toThrow(/does not match the release asset size/);
	});

	it('rejects a malformed asset and maps a failed download to unavailable', async () => {
		const malformed: Array<[Uint8Array, RegExp]> = [
			[new TextEncoder().encode('not json'), /not valid JSON/],
			[new TextEncoder().encode('[1,2]'), /must be a JSON object/],
			[new TextEncoder().encode('{"mediaType":"x"}'), /missing its signed statement/],
			[
				new TextEncoder().encode(
					JSON.stringify({ dsseEnvelope: { payload: Buffer.from('nope').toString('base64') } })
				),
				/statement is not valid JSON/
			]
		];
		for (const [bytes, message] of malformed) {
			const { release, http } = maintainerRelease(bytes);
			await expect(
				createGithubProvenanceVerifier(http, async () => ({}), OPTIONS).verify(
					release,
					release.manifest.bundle.sha256
				),
				message.source
			).rejects.toThrow(message);
		}
		for (const status of [404, 503]) {
			const { release, http } = maintainerRelease(maintainerStatement(baseRelease()));
			http.replace(signatureUrl(release), new Uint8Array(), status);
			await expect(
				createGithubProvenanceVerifier(http, async () => ({}), OPTIONS).verify(
					release,
					release.manifest.bundle.sha256
				)
			).rejects.toMatchObject({ code: 'unavailable', exitCode: 5 });
		}
	});

	it('maps signature failures and an unavailable trust root like the workflow path', async () => {
		const first = maintainerRelease(maintainerStatement(baseRelease()));
		await expect(
			createGithubProvenanceVerifier(
				first.http,
				async () => {
					throw new Error('bad signature');
				},
				OPTIONS
			).verify(first.release, first.release.manifest.bundle.sha256)
		).rejects.toMatchObject({ exitCode: 1 });
		const second = maintainerRelease(maintainerStatement(baseRelease()));
		await expect(
			createGithubProvenanceVerifier(
				second.http,
				async () => {
					throw new Error('network timeout');
				},
				OPTIONS
			).verify(second.release, second.release.manifest.bundle.sha256)
		).rejects.toMatchObject({ code: 'unavailable', exitCode: 5 });
	});

	it('verifies a local bundle with the same policy as the online path', async () => {
		const release = baseRelease();
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

describe('maintainer signature asset resolution', () => {
	it('records the asset when the release has one and checks its URL', async () => {
		const bundle = sampleBundleBytes();
		const manifest = sampleManifest({
			bundle: { ...sampleManifest().bundle, size: bundle.byteLength, sha256: sha256Hex(bundle) }
		});
		const name = maintainerSignatureAssetName('v1.2.3');
		expect(name).toBe('signkit-provenance-v1.2.3.sigstore.json');

		const plain = new FakeHttp();
		plain.on(`${API}/releases/tags/v1.2.3`, githubReleaseJson({ tag: 'v1.2.3' }));
		plain.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		const workflowRelease = await createGithubReleaseResolver(plain).resolve({
			version: 'v1.2.3',
			channel: 'stable'
		});
		expect(workflowRelease.maintainerSignature).toBeUndefined();

		const signed = new FakeHttp();
		const json = githubReleaseJson({ tag: 'v1.2.3' });
		(json.assets as unknown[]).push({
			name,
			size: 4096,
			browser_download_url: `${DL}/v1.2.3/${name}`,
			content_type: 'application/json'
		});
		signed.on(`${API}/releases/tags/v1.2.3`, json);
		signed.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		await expect(
			createGithubReleaseResolver(signed).resolve({ version: 'v1.2.3', channel: 'stable' })
		).resolves.toMatchObject({ maintainerSignature: { assetName: name, size: 4096 } });

		const evil = new FakeHttp();
		const evilJson = structuredClone(json);
		(evilJson.assets as Array<{ browser_download_url: string }>)[2]!.browser_download_url =
			'https://evil.example/signature.json';
		evil.on(`${API}/releases/tags/v1.2.3`, evilJson);
		evil.on(`${DL}/v1.2.3/signkit-cloudflare-manifest.json`, JSON.stringify(manifest));
		await expect(
			createGithubReleaseResolver(evil).resolve({ version: 'v1.2.3', channel: 'stable' })
		).rejects.toThrow(/not an allowed GitHub origin/);
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
			{
				tag: 'v1.2.3',
				commit: COMMIT,
				subjects: [{ name: 'a.tar.gz', sha256: 'A'.repeat(64) }]
			},
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

function baseRelease(tag = 'v1.2.3', channel: 'stable' | 'beta' = 'stable'): ResolvedRelease {
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
		manifestUrl: `${DL}/${tag}/signkit-cloudflare-manifest.json`,
		bundleUrl: `${DL}/${tag}/${manifest.bundle.assetName}`
	};
}

/**
 * A release with the maintainer signature asset: the attestations API has
 * nothing (or `attestations`), and the asset holds `signature`, a statement to
 * wrap in a fixture bundle or raw bytes.
 */
function maintainerRelease(
	signature: Statement | Uint8Array,
	release: ResolvedRelease = baseRelease(),
	attestations: unknown[] = []
): { release: ResolvedRelease; http: FakeHttp } {
	const bytes =
		signature instanceof Uint8Array
			? signature
			: new TextEncoder().encode(JSON.stringify(signedBundle(signature)));
	const signed: ResolvedRelease = {
		...release,
		maintainerSignature: {
			assetName: maintainerSignatureAssetName(release.tag),
			size: bytes.byteLength
		}
	};
	const http = attestationHttp(signed, attestations);
	http.on(signatureUrl(signed), bytes);
	return { release: signed, http };
}

function signatureUrl(release: ResolvedRelease): string {
	return `${DL}/${release.tag}/${maintainerSignatureAssetName(release.tag)}`;
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

function attestationApiUrl(digest: string): string {
	return `${API}/attestations/sha256:${digest}?predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1&per_page=10`;
}

function attestationHttp(release: ResolvedRelease, statements: unknown[]): FakeHttp {
	const http = new FakeHttp();
	if (statements.length === 0) {
		http.on(attestationApiUrl(release.manifest.bundle.sha256), {}, 404);
		return http;
	}
	const urls = statements.map((_, index) =>
		BLOB_URL.replace('654321.json.sn', `${654321 + index}.json.sn`)
	);
	http.on(attestationApiUrl(release.manifest.bundle.sha256), {
		attestations: urls.map((bundle_url) => ({ bundle_url, repository_id: REPOSITORY_ID }))
	});
	for (let index = 0; index < statements.length; index += 1) {
		http.on(
			urls[index]!,
			compress(new TextEncoder().encode(JSON.stringify(signedBundle(statements[index]))))
		);
	}
	return http;
}
