import { SealContainer } from './container-proxy';
import { authenticated, unavailable } from './security';

interface EngineEnvironment {
	PROCESS: DurableObjectNamespace<SigningEngine>;
	ENGINE_TOKEN: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_REGION?: string;
	AWS_KMS_KEY_ARN?: string;
	VERCEL_SIGNER_URL?: string;
	VERCEL_SIGNER_TOKEN?: string;
	VERCEL_KMS_KEY_ID?: string;
	VERCEL_KMS_FINGERPRINT?: string;
	SEAL_CERTIFICATE_DER: string;
	SEAL_CA_DER: string;
}

/** This runtime is addressable by a service binding from the trusted gateway. */
export class SigningEngine extends SealContainer<EngineEnvironment> {
	protected readonly enableInternet = true;

	protected containerEnvironment(): Record<string, string> {
		const env = this.env;
		const keyService: Record<string, string> = env.VERCEL_SIGNER_URL
			? {
					VERCEL_SIGNER_URL: env.VERCEL_SIGNER_URL,
					VERCEL_SIGNER_TOKEN: env.VERCEL_SIGNER_TOKEN ?? '',
					VERCEL_KMS_KEY_ID: env.VERCEL_KMS_KEY_ID ?? '',
					VERCEL_KMS_FINGERPRINT: env.VERCEL_KMS_FINGERPRINT ?? ''
				}
			: {
					AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? '',
					AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? '',
					AWS_REGION: env.AWS_REGION ?? '',
					AWS_KMS_KEY_ARN: env.AWS_KMS_KEY_ARN ?? ''
				};
		return {
			ENGINE_TOKEN: env.ENGINE_TOKEN,
			SEAL_CERTIFICATE_DER: env.SEAL_CERTIFICATE_DER,
			SEAL_CA_DER: env.SEAL_CA_DER,
			...keyService
		};
	}
}

export default {
	async fetch(request: Request, env: EngineEnvironment): Promise<Response> {
		if (!authenticated(request, env.ENGINE_TOKEN)) return unavailable(401);
		const path = new URL(request.url).pathname;
		if (
			!(path === '/seal' && request.method === 'POST') &&
			!(path === '/healthz' && request.method === 'GET')
		)
			return unavailable(404);
		return await env.PROCESS.getByName('sign').proxy(request);
	}
} satisfies ExportedHandler<EngineEnvironment>;
