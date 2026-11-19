import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { SealContainer } from './container-proxy';
import { authenticated, unavailable } from './security';

interface ValidatorEnvironment {
	PROCESS: DurableObjectNamespace<ValidationEngine>;
	VALIDATOR_TOKEN: string;
	SEAL_CA_DER: string;
	SEAL_CERTIFICATE_SHA256: string;
	SEAL_POLICY_ID: string;
	VALIDATION_POLICY_ID: string;
}

export class ValidationEngine extends SealContainer<ValidatorEnvironment> {
	protected readonly enableInternet = false;
	protected override readonly readinessTimeoutMs = 30_000;

	protected containerEnvironment(): Record<string, string> {
		const env = this.env;
		return {
			VALIDATOR_TOKEN: env.VALIDATOR_TOKEN,
			SEAL_CA_DER: env.SEAL_CA_DER,
			SEAL_CERTIFICATE_SHA256: env.SEAL_CERTIFICATE_SHA256,
			SEAL_POLICY_ID: env.SEAL_POLICY_ID,
			VALIDATION_POLICY_ID: env.VALIDATION_POLICY_ID
		};
	}
}

export default {
	async fetch(request: Request, env: ValidatorEnvironment): Promise<Response> {
		if (!authenticated(request, env.VALIDATOR_TOKEN)) return unavailable(401);
		const path = new URL(request.url).pathname;
		const id = /^\/pdf-seal-validations\/([^/]+)$/.exec(path)?.[1];
		if (id === undefined || !UUID_V7_PATTERN.test(id) || request.method !== 'PUT')
			return unavailable(404);
		return await env.PROCESS.getByName('validate').proxy(request);
	}
} satisfies ExportedHandler<ValidatorEnvironment>;
