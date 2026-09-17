import { Buffer } from 'node:buffer';

export interface ParsedReleaseTag {
	raw: string;
	major: number;
	minor: number;
	patch: number;
	prerelease?: string;
}

export type NpmDistTag = 'latest' | 'beta';

const RELEASE_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
const NUMERIC_PRERELEASE_IDENTIFIER_RE = /^[0-9]+$/;
export const MAX_RELEASE_TAG_BYTES = 35;

export function resolveReleaseTag(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.SIGNKIT_RELEASE_TAG;
	if (typeof override === 'string' && override.length > 0) {
		return override;
	}
	const fromRef = env.GITHUB_REF_NAME;
	return typeof fromRef === 'string' ? fromRef : '';
}

export function parseReleaseTag(tag: string): ParsedReleaseTag {
	const raw = tag.trim();
	if (Buffer.byteLength(raw, 'utf8') > MAX_RELEASE_TAG_BYTES) {
		throw new Error(
			`release tag exceeds the ${MAX_RELEASE_TAG_BYTES}-byte provenance identity limit`
		);
	}
	if (raw.includes('+')) {
		throw new Error(
			`release tag ${JSON.stringify(raw)} includes build metadata; tags with +build metadata are not supported`
		);
	}
	const match = RELEASE_TAG_RE.exec(raw);
	if (!match) {
		throw new Error(
			`release tag must be a semver like v1.2.3 or v1.2.3-beta.1, got ${JSON.stringify(tag)}`
		);
	}
	return {
		raw,
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4]
	};
}

export function channelFromReleaseTag(tag: string): 'stable' | 'beta' {
	return parseReleaseTag(tag).prerelease ? 'beta' : 'stable';
}

export function npmDistTagFromChannel(channel: 'stable' | 'beta'): NpmDistTag {
	return channel === 'beta' ? 'beta' : 'latest';
}

export function npmDistTagFromReleaseTag(tag: string): NpmDistTag {
	return npmDistTagFromChannel(channelFromReleaseTag(tag));
}

export function tagHasSemverPrerelease(tag: string): boolean {
	try {
		return parseReleaseTag(tag).prerelease !== undefined;
	} catch {
		return false;
	}
}

export function compareReleaseTags(left: string, right: string): number {
	return compareParsedReleaseTags(parseReleaseTag(left), parseReleaseTag(right));
}

export function compareParsedReleaseTags(left: ParsedReleaseTag, right: ParsedReleaseTag): number {
	if (left.major !== right.major) return Math.sign(left.major - right.major);
	if (left.minor !== right.minor) return Math.sign(left.minor - right.minor);
	if (left.patch !== right.patch) return Math.sign(left.patch - right.patch);
	if (left.prerelease === undefined && right.prerelease === undefined) return 0;
	if (left.prerelease === undefined) return 1;
	if (right.prerelease === undefined) return -1;
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
	const leftParts = left.split('.');
	const rightParts = right.split('.');
	const count = Math.max(leftParts.length, rightParts.length);
	for (let i = 0; i < count; i += 1) {
		const leftPart = leftParts[i];
		const rightPart = rightParts[i];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		const cmp = comparePrereleaseIdentifier(leftPart, rightPart);
		if (cmp !== 0) return cmp;
	}
	return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
	const leftNumeric = NUMERIC_PRERELEASE_IDENTIFIER_RE.test(left);
	const rightNumeric = NUMERIC_PRERELEASE_IDENTIFIER_RE.test(right);
	if (leftNumeric && rightNumeric) {
		const delta = BigInt(left) - BigInt(right);
		if (delta < 0n) return -1;
		if (delta > 0n) return 1;
		return 0;
	}
	if (leftNumeric) return -1;
	if (rightNumeric) return 1;
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
