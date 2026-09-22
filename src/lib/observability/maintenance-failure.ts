export const MAINTENANCE_FAILURE_CODE_HEADER: string = 'x-signkit-maintenance-failure-code';

const SAFE_FAILURE_CODE: RegExp = /^[a-z][a-z0-9_]{0,63}$/;

export function maintenanceFailureHeaders(code: string): HeadersInit {
	if (!SAFE_FAILURE_CODE.test(code)) {
		throw new Error('maintenance failure code must be a safe identifier');
	}
	return { [MAINTENANCE_FAILURE_CODE_HEADER]: code };
}

export function hasHandledMaintenanceFailure(response: Response): boolean {
	const code: string | null = response.headers.get(MAINTENANCE_FAILURE_CODE_HEADER);
	return code !== null && SAFE_FAILURE_CODE.test(code);
}
