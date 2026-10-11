import { describe, expect, it } from 'vitest';
import {
	cappedExponentialBackoffAvailableAt,
	cappedExponentialBackoffMs
} from './capped-exponential-backoff';

describe('cappedExponentialBackoffMs', () => {
	const baseDelayMs = 30_000;
	const maxDelayMs = 6 * 60 * 60 * 1000;
	const exponentCap = 10;

	it('treats a negative attempt count the same as attempt 1', () => {
		expect(cappedExponentialBackoffMs(-5, baseDelayMs, maxDelayMs, exponentCap)).toBe(baseDelayMs);
	});

	it('treats attempt 0 the same as attempt 1', () => {
		expect(cappedExponentialBackoffMs(0, baseDelayMs, maxDelayMs, exponentCap)).toBe(baseDelayMs);
	});

	it('returns the base delay for attempt 1', () => {
		expect(cappedExponentialBackoffMs(1, baseDelayMs, maxDelayMs, exponentCap)).toBe(baseDelayMs);
	});

	it('doubles the delay for each attempt below the exponent cap', () => {
		expect(cappedExponentialBackoffMs(2, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			baseDelayMs * 2
		);
		expect(cappedExponentialBackoffMs(4, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			baseDelayMs * 8
		);
	});

	it('stops doubling once the exponent cap is reached', () => {
		const atCap = cappedExponentialBackoffMs(exponentCap + 1, baseDelayMs, maxDelayMs, exponentCap);
		const wellPastCap = cappedExponentialBackoffMs(
			exponentCap + 50,
			baseDelayMs,
			maxDelayMs,
			exponentCap
		);
		expect(atCap).toBe(wellPastCap);
		expect(atCap).toBe(maxDelayMs);
	});

	it('clamps to maxDelayMs for a very large attempt count', () => {
		expect(cappedExponentialBackoffMs(1_000_000, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			maxDelayMs
		);
	});

	it('honors a caller-chosen exponent cap below the point maxDelayMs would otherwise bind', () => {
		const webhookExponentCap = 5;
		const webhookMaxDelayMs = baseDelayMs * 32;
		expect(cappedExponentialBackoffMs(6, baseDelayMs, webhookMaxDelayMs, webhookExponentCap)).toBe(
			baseDelayMs * 32
		);
		expect(cappedExponentialBackoffMs(7, baseDelayMs, webhookMaxDelayMs, webhookExponentCap)).toBe(
			baseDelayMs * 32
		);
	});

	it('preserves fractional and nonfinite input without adding validation or rounding', () => {
		expect(cappedExponentialBackoffMs(1.5, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			42426.406871192856
		);
		expect(cappedExponentialBackoffMs(-Infinity, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			baseDelayMs
		);
		expect(cappedExponentialBackoffMs(Infinity, baseDelayMs, maxDelayMs, exponentCap)).toBe(
			maxDelayMs
		);
		expect(cappedExponentialBackoffMs(NaN, baseDelayMs, maxDelayMs, exponentCap)).toBeNaN();
		expect(cappedExponentialBackoffMs(6.5, baseDelayMs, baseDelayMs * 32, 5)).toBe(960_000);
	});
});

it('offsets the given instant by the computed delay', () => {
	const availableAt = cappedExponentialBackoffAvailableAt(new Date(0), 1, 30_000, 21_600_000, 10);
	expect(availableAt).toBe(new Date(30_000).toISOString());
});
