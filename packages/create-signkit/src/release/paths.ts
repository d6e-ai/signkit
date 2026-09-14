import { relative, sep } from 'node:path';

export const POSIX_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
export const ENV_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function posixRelativeToRoot(root: string, absolute: string, label: string): string {
	const posix = relative(root, absolute).split(sep).join('/');
	if (
		!posix ||
		posix === '.' ||
		posix === '..' ||
		posix.startsWith('../') ||
		posix.startsWith('/')
	) {
		throw new Error(`${label} must stay inside the bundle root as a relative POSIX path`);
	}
	return assertSafeRelativePosixPath(posix, label);
}

export function isSafeRelativePosixPath(value: string): boolean {
	if (typeof value !== 'string' || value.length === 0) {
		return false;
	}
	if (value.includes('\0') || value.includes('\\')) {
		return false;
	}
	if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
		return false;
	}
	const parts = value.split('/');
	if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
		return false;
	}
	return POSIX_RELATIVE_PATH_PATTERN.test(value);
}

export function assertSafeRelativePosixPath(value: string, label: string): string {
	if (!isSafeRelativePosixPath(value)) {
		throw new Error(
			`${label} must be a nonempty relative POSIX path without absolute, drive, dot, dotdot, backslash, or NUL`
		);
	}
	return value;
}

export function isEnvIdentifier(name: string): boolean {
	return ENV_IDENTIFIER_PATTERN.test(name);
}

export function uniqueEnvIdentifiers(names: readonly unknown[], label: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		if (typeof name !== 'string' || !isEnvIdentifier(name)) {
			throw new Error(`${label} must contain unique nonempty environment identifiers`);
		}
		if (seen.has(name)) {
			throw new Error(`${label} must not contain duplicate name ${name}`);
		}
		seen.add(name);
		result.push(name);
	}
	return result;
}
