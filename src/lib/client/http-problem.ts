/**
 * RFC 9457 (Problem Details) parsing and the generic JSON transport shared
 * by every sender-facing API client in `src/lib/client`. Each client keeps
 * its own Error subclass and ambiguous-failure status classification local,
 * since those differ per operation; only the identical wire parsing lives
 * here.
 */

export interface ProblemValidationError {
	readonly path: string;
	readonly message: string;
}

export interface Problem {
	readonly status: number;
	readonly type: string;
	readonly title: string;
	readonly detail: string;
	readonly instance?: string;
	readonly errors?: readonly ProblemValidationError[];
}

/**
 * Mints an opaque `Idempotency-Key`, not a SignKit resource identifier.
 * Keep the existing randomUUID generator; callers reuse the value without
 * interpreting its UUID version or contents.
 */
export function defaultNewIdempotencyKey(): string {
	const source: Crypto | undefined = globalThis.crypto;
	if (source === undefined || typeof source.randomUUID !== 'function') {
		throw new Error('crypto.randomUUID() is required to mint an Idempotency-Key');
	}
	return source.randomUUID();
}

export function isReplayedResponse(response: Response): boolean {
	return response.headers.get('idempotency-replayed') === 'true';
}

/** The bounded problem thrown when a successful response body is not valid JSON. */
export function invalidResponseJsonProblem(path: string, status: number): Problem {
	return {
		status,
		type: 'urn:signkit:problem:invalid-response-json',
		title: 'Invalid response JSON',
		detail: 'The response body could not be parsed as JSON.',
		instance: path
	};
}

/**
 * Parses an RFC 9457 `application/problem+json` body when present, falling
 * back to a bounded problem synthesized from the HTTP status when the body
 * is missing, non-JSON, or malformed. Never throws: a response that fails
 * parsing still yields a usable problem rather than leaking an unparsed body.
 */
export async function parseProblemResponse(
	response: Response,
	defaultInstance: string
): Promise<Problem> {
	const contentType = response.headers.get('content-type') ?? '';
	if (contentType.includes('json')) {
		try {
			const data = (await response.json()) as Record<string, unknown>;
			if (data && typeof data === 'object') {
				const type =
					typeof data.type === 'string' ? data.type : `urn:signkit:problem:http-${response.status}`;
				const title = typeof data.title === 'string' ? data.title : response.statusText || 'Error';
				const detail =
					typeof data.detail === 'string'
						? data.detail
						: `Request failed with status ${response.status}`;
				const instance = typeof data.instance === 'string' ? data.instance : defaultInstance;
				let errors: ProblemValidationError[] | undefined;
				if (Array.isArray(data.errors)) {
					errors = data.errors
						.filter(
							(e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null
						)
						.map((e: Record<string, unknown>) => ({
							path: typeof e.path === 'string' ? e.path : '$',
							message: typeof e.message === 'string' ? e.message : 'Validation error'
						}));
				}
				return {
					status: typeof data.status === 'number' ? data.status : response.status,
					type,
					title,
					detail,
					instance,
					...(errors && errors.length > 0 ? { errors } : {})
				};
			}
		} catch {
			// Malformed JSON on an error response: fall through to the bounded
			// generic problem below rather than leaking an unparsed body.
		}
	}
	return {
		status: response.status,
		type: `urn:signkit:problem:http-${response.status}`,
		title: response.statusText || 'Error',
		detail: `Request failed with status ${response.status}`,
		instance: defaultInstance
	};
}

/**
 * Issues a request and parses its JSON body, routing both HTTP-level problem
 * responses and malformed success bodies through `buildError` so each caller
 * keeps throwing its own Error subclass.
 */
export async function requestJson<T>(
	fetchFn: typeof globalThis.fetch,
	path: string,
	init: RequestInit,
	buildError: (problem: Problem, replayed: boolean) => Error
): Promise<{ data: T; response: Response }> {
	const response: Response = await fetchFn(path, { credentials: 'same-origin', ...init });
	if (!response.ok) {
		throw buildError(await parseProblemResponse(response, path), isReplayedResponse(response));
	}
	try {
		const data: T = (await response.json()) as T;
		return { data, response };
	} catch {
		throw buildError(invalidResponseJsonProblem(path, response.status), false);
	}
}
