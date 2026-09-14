export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export class CliError extends Error {
	readonly exitCode: ExitCode;
	readonly code: string;

	constructor(message: string, exitCode: ExitCode, code: string) {
		super(message);
		this.name = 'CliError';
		this.exitCode = exitCode;
		this.code = code;
	}
}

export function usage(message: string): CliError {
	return new CliError(message, 2, 'usage');
}

export function conflict(message: string): CliError {
	return new CliError(message, 4, 'conflict');
}

export function unavailable(message: string): CliError {
	return new CliError(message, 5, 'unavailable');
}

export function preflight(message: string): CliError {
	return new CliError(message, 6, 'preflight');
}

export function generic(message: string): CliError {
	return new CliError(message, 1, 'error');
}

export function isCliError(error: unknown): error is CliError {
	return error instanceof CliError;
}
