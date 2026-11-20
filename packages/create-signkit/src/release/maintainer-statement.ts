import { SIGNKIT_REPOSITORY } from '../constants.js';
import { parseReleaseTag } from './semver.js';

/**
 * The signed statement of a maintainer-built release. `scripts/release-local.mjs`
 * creates it with {@link createMaintainerReleaseStatement}, and the verifier in
 * `provenance.ts` accepts only statements with exactly this shape.
 */
export const MAINTAINER_BUILD_TYPE = `https://github.com/${SIGNKIT_REPOSITORY}/release/maintainer/v1`;
export const MAINTAINER_REPOSITORY_URL = `https://github.com/${SIGNKIT_REPOSITORY}`;
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const SLSA_PROVENANCE_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

const MAX_SUBJECTS = 1024;

export interface MaintainerStatementSubject {
	name: string;
	sha256: string;
}

export interface MaintainerExternalParameters {
	repository: string;
	ref: string;
	commit: string;
}

export interface MaintainerReleaseStatement {
	_type: typeof IN_TOTO_STATEMENT_TYPE;
	subject: Array<{ name: string; digest: { sha256: string } }>;
	predicateType: typeof SLSA_PROVENANCE_PREDICATE_TYPE;
	predicate: {
		buildDefinition: {
			buildType: typeof MAINTAINER_BUILD_TYPE;
			externalParameters: MaintainerExternalParameters;
			internalParameters: Record<string, unknown>;
		};
		runDetails: {
			builder: { id: string };
			metadata?: { startedOn?: string; finishedOn?: string };
		};
	};
}

export interface MaintainerStatementInput {
	tag: string;
	commit: string;
	subjects: readonly MaintainerStatementSubject[];
	/** Informational, non-secret build facts (tool versions). Not verified. */
	internalParameters?: Record<string, unknown>;
	startedOn?: string;
	finishedOn?: string;
}

export function createMaintainerReleaseStatement(
	input: MaintainerStatementInput
): MaintainerReleaseStatement {
	const tag = parseReleaseTag(input.tag).raw;
	if (!tag.startsWith('v') || tag !== input.tag) {
		throw new Error(
			`release tag must be a v-prefixed semver tag, got ${JSON.stringify(input.tag)}`
		);
	}
	if (!/^[0-9a-f]{40}$/.test(input.commit)) {
		throw new Error('release commit must be a 40-character lowercase hex SHA');
	}
	if (input.subjects.length === 0 || input.subjects.length > MAX_SUBJECTS) {
		throw new Error(`release statement needs between 1 and ${MAX_SUBJECTS} subjects`);
	}
	const names = new Set<string>();
	for (const subject of input.subjects) {
		if (
			typeof subject.name !== 'string' ||
			subject.name.length === 0 ||
			subject.name.length > 255 ||
			subject.name.includes('/')
		) {
			throw new Error(`release statement subject name ${JSON.stringify(subject.name)} is invalid`);
		}
		if (!/^[0-9a-f]{64}$/.test(subject.sha256)) {
			throw new Error(`release statement subject ${subject.name} has an invalid sha256`);
		}
		if (names.has(subject.name)) {
			throw new Error(`release statement subject ${subject.name} is duplicated`);
		}
		names.add(subject.name);
	}
	const subject = [...input.subjects]
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map(({ name, sha256 }) => ({ name, digest: { sha256 } }));
	const metadata: { startedOn?: string; finishedOn?: string } = {};
	if (input.startedOn) metadata.startedOn = input.startedOn;
	if (input.finishedOn) metadata.finishedOn = input.finishedOn;
	return {
		_type: IN_TOTO_STATEMENT_TYPE,
		subject,
		predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
		predicate: {
			buildDefinition: {
				buildType: MAINTAINER_BUILD_TYPE,
				externalParameters: {
					repository: MAINTAINER_REPOSITORY_URL,
					ref: `refs/tags/${tag}`,
					commit: input.commit
				},
				internalParameters: { ...(input.internalParameters ?? {}) }
			},
			runDetails: {
				builder: {
					id: `${MAINTAINER_REPOSITORY_URL}/blob/${input.commit}/scripts/release-local.mjs`
				},
				...(Object.keys(metadata).length > 0 ? { metadata } : {})
			}
		}
	};
}
