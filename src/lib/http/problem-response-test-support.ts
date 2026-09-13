import { expect } from 'vitest';
import type { ProblemDetail } from './problem';

export type ExpectedProblem = Partial<ProblemDetail> & { status: number; type: string };

/**
 * Asserts a `Response` is a well-formed RFC 9457 problem+json error matching
 * `expected` (status, content-type, and every field given), then returns the
 * parsed body for any further assertions the caller needs (e.g. `errors`).
 */
export async function expectProblemResponse(
	response: Response,
	expected: ExpectedProblem
): Promise<ProblemDetail> {
	expect(response.status).toBe(expected.status);
	expect(response.headers.get('content-type')).toBe('application/problem+json');
	const body = (await response.json()) as ProblemDetail;
	expect(body).toMatchObject(expected);
	return body;
}
