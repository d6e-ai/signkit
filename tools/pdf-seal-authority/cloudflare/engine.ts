import { SealContainer } from './container-proxy';
import { authenticated, unavailable } from './security';

interface EngineEnvironment {
	PROCESS: DurableObjectNamespace<SigningEngine>;
	ENGINE_TOKEN: string;
	AWS_ACCESS_KEY_ID: string;
	AWS_SECRET_ACCESS_KEY: string;
	AWS_REGION: string;
	AWS_KMS_KEY_ARN: string;
	SEAL_CERTIFICATE_DER: string;
	SEAL_CA_DER: string;
}

/** This runtime is addressable by a service binding from the trusted gateway. */
export class SigningEngine extends SealContainer<EngineEnvironment> {
	protected readonly enableInternet = true;

	protected containerEnvironment(): Record<string, string> {
		const env = this.env;
		return {
			ENGINE_TOKEN: env.ENGINE_TOKEN,
			AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
			AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
			AWS_REGION: env.AWS_REGION,
			AWS_KMS_KEY_ARN: env.AWS_KMS_KEY_ARN,
			SEAL_CERTIFICATE_DER: env.SEAL_CERTIFICATE_DER,
			SEAL_CA_DER: env.SEAL_CA_DER
		};
	}
}

export default {
	async fetch(request: Request, env: EngineEnvironment): Promise<Response> {
		if (!authenticated(request, env.ENGINE_TOKEN)) return unavailable(401);
		const path = new URL(request.url).pathname;
		if (path !== '/seal' || request.method !== 'POST') return unavailable(404);
		return await env.PROCESS.getByName('sign').proxy(request);
	}
} satisfies ExportedHandler<EngineEnvironment>;
