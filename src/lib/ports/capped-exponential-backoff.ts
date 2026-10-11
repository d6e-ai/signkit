/**
 * Shared arithmetic for "capped exponential backoff": the delay doubles per
 * attempt up to `exponentCap` doublings, then stays flat, and the result is
 * additionally clamped to `maxDelayMs`. `attempts` below 1 are treated as 1
 * so a caller never computes a negative or zero exponent.
 *
 * Callers own their `baseDelayMs`, `maxDelayMs`, and `exponentCap`: this
 * function fixes none of them, so each job's existing retry budget and
 * curve is unchanged by sharing this arithmetic.
 */
export function cappedExponentialBackoffMs(
	attempts: number,
	baseDelayMs: number,
	maxDelayMs: number,
	exponentCap: number
): number {
	const safeAttempts: number = Math.max(1, attempts);
	const exponent: number = Math.min(safeAttempts - 1, exponentCap);
	return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

/** {@link cappedExponentialBackoffMs}, returned as an ISO timestamp offset from `now`. */
export function cappedExponentialBackoffAvailableAt(
	now: Date,
	attempts: number,
	baseDelayMs: number,
	maxDelayMs: number,
	exponentCap: number
): string {
	return new Date(
		now.valueOf() + cappedExponentialBackoffMs(attempts, baseDelayMs, maxDelayMs, exponentCap)
	).toISOString();
}
