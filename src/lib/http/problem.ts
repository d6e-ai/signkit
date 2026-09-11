export interface ProblemDetail {
	type: string;
	title: string;
	status: number;
	detail: string;
	instance: string;
	errors?: readonly ProblemValidationError[];
}

export interface ProblemValidationError {
	path: string;
	message: string;
}

export function problemResponse(problem: ProblemDetail, headers?: HeadersInit): Response {
	const responseHeaders: Headers = new Headers(headers);
	responseHeaders.set('content-type', 'application/problem+json');
	responseHeaders.set('cache-control', 'no-store');
	return new Response(JSON.stringify(problem), {
		status: problem.status,
		headers: responseHeaders
	});
}
