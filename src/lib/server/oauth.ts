export const OAUTH_STATE_COOKIE = 'signkit_oauth_state';
export const OAUTH_RETURN_COOKIE = 'signkit_oauth_return';

export function safeReturnPath(value: string | null): string | null {
	return value?.startsWith('/') && !value.startsWith('//') ? value : null;
}
