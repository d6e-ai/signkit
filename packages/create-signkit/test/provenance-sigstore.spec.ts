import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import {
	toSignedEntity,
	toTrustMaterial,
	Verifier,
	type VerificationPolicy
} from '@sigstore/verify';
import { uncompress } from 'snappyjs';
import { describe, expect, it } from 'vitest';
import {
	createGithubCertificatePolicy,
	type GithubCertificatePolicy
} from '../src/release/provenance.js';

const FIXTURE_DIR = new URL('./fixtures/provenance/', import.meta.url);
const BUNDLE_SHA256 = '75f9a984c490db8d9cdc8bdacf19de2e834203cc8d81b422d1b616a4fc4e3f6d';

describe('Sigstore integration fixture', () => {
	it('verifies a genuine default-subject GitHub tag-push attestation offline', async () => {
		const encodedBundle = await readFile(
			new URL('diesel-v2.3.13.bundle.sn.base64', FIXTURE_DIR),
			'utf8'
		);
		const compressedBundle = Buffer.from(encodedBundle.replaceAll(/\s/g, ''), 'base64');
		expect(createHash('sha256').update(compressedBundle).digest('hex')).toBe(BUNDLE_SHA256);
		const serializedBundle = JSON.parse(
			Buffer.from(uncompress(compressedBundle, 4 * 1024 * 1024)).toString('utf8')
		) as unknown;
		const trustedRoot = TrustedRoot.fromJSON(
			JSON.parse(
				await readFile(new URL('sigstore-public-good-trusted-root.json', FIXTURE_DIR), 'utf8')
			) as unknown
		);
		const certificatePolicy = createGithubCertificatePolicy({
			repository: 'diesel-rs/diesel',
			repositoryId: '41609775',
			repositoryOwner: 'diesel-rs',
			repositoryOwnerId: '16763251',
			workflowPath: '.github/workflows/release.yml',
			sourceRef: 'refs/tags/v2.3.13',
			commit: '9628f5ca470dea2adaa8194365541e304e3d56dc',
			eventName: 'push'
		});
		// This historical fixture predates GitHub's owner/repository-id-qualified
		// runner-identity claim. Production policy uses the current exact form.
		certificatePolicy.verifyOptions.certificateOIDs['1.3.6.1.4.1.57264.1.24'] = derUtf8String(
			'repo:diesel-rs/diesel:ref:refs/tags/v2.3.13'
		);
		const verifier = new Verifier(toTrustMaterial(trustedRoot), {
			ctlogThreshold: 1,
			tlogThreshold: 1
		});

		expect(() =>
			verifier.verify(
				toSignedEntity(bundleFromJSON(serializedBundle)),
				toVerificationPolicy(certificatePolicy)
			)
		).not.toThrow();
	});
});

function toVerificationPolicy(policy: GithubCertificatePolicy): VerificationPolicy {
	return {
		subjectAlternativeName: policy.verifyOptions.certificateIdentityURI,
		extensions: { issuer: policy.verifyOptions.certificateIssuer },
		oids: Object.entries(policy.verifyOptions.certificateOIDs).map(([oid, value]) => ({
			oid: { id: oid.split('.').map(Number) },
			value: Buffer.from(value)
		}))
	};
}

function derUtf8String(value: string): string {
	const bytes = Buffer.from(value, 'utf8');
	return String.fromCharCode(0x0c, bytes.byteLength, ...bytes);
}
