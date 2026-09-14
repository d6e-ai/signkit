import type { ProviderId } from '../cli/parse.js';
import { usage } from '../cli/errors.js';

export const IMPLEMENTED_PROVIDERS = new Set<ProviderId>(['cloudflare']);

export function assertProviderImplemented(provider: ProviderId): void {
	if (provider === 'cloudflare') {
		return;
	}
	throw usage(
		`provider --${provider} is recognized but not implemented in this slice; use --cloudflare. Provider flags are mutually exclusive.`
	);
}
