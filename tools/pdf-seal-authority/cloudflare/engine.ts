import { SealContainer } from './container-proxy';
import { placedObject } from './placement';
import { authenticated, unavailable } from './security';

interface EngineEnvironment {
	ENGINE_TOKEN: string;
	SEAL_KEY_BACKEND?: string;
	SEAL_LOCATION_HINT?: string;
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_REGION?: string;
	AWS_KMS_KEY_ARN?: string;
	VERCEL_SIGNER_URL?: string;
	VERCEL_SIGNER_TOKEN?: string;
	VERCEL_KMS_KEY_ID?: string;
	VERCEL_KMS_FINGERPRINT?: string;
	HSM_SIGNER_URL?: string;
	HSM_SIGNER_TOKEN?: string;
	HSM_SIGNER_KEY_ID?: string;
	HSM_SIGNER_FINGERPRINT?: string;
	SEAL_CERTIFICATE_DER: string;
	SEAL_CA_DER: string;
}

const backendSettings = {
	'aws-kms': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_KMS_KEY_ARN'],
	'vercel-kms': [
		'VERCEL_SIGNER_URL',
		'VERCEL_SIGNER_TOKEN',
		'VERCEL_KMS_KEY_ID',
		'VERCEL_KMS_FINGERPRINT'
	],
	'pkcs11-hsm': [
		'HSM_SIGNER_URL',
		'HSM_SIGNER_TOKEN',
		'HSM_SIGNER_KEY_ID',
		'HSM_SIGNER_FINGERPRINT'
	]
} as const;

function selectedSettings(backend: string | undefined) {
	if (backend === undefined) return Object.values(backendSettings).flat();
	if (backend === 'aws-kms' || backend === 'vercel-kms' || backend === 'pkcs11-hsm') {
		return backendSettings[backend];
	}
	return [];
}

/** This runtime is addressable by a service binding from the trusted gateway. */
export class SigningEngine extends SealContainer<EngineEnvironment> {
	protected readonly enableInternet = true;

	protected containerEnvironment(): Record<string, string> {
		const env = this.env;
		const settings: Record<string, string> = {
			ENGINE_TOKEN: env.ENGINE_TOKEN,
			SEAL_CERTIFICATE_DER: env.SEAL_CERTIFICATE_DER,
			SEAL_CA_DER: env.SEAL_CA_DER
		};
		// A new Worker version inherits existing secrets. Only pass the selected backend to Python.
		if (env.SEAL_KEY_BACKEND !== undefined) settings.SEAL_KEY_BACKEND = env.SEAL_KEY_BACKEND;
		for (const name of selectedSettings(env.SEAL_KEY_BACKEND)) {
			const value = env[name];
			if (value !== undefined) settings[name] = value;
		}
		return settings;
	}
}

export default {
	async fetch(request: Request, env: EngineEnvironment, ctx: ExecutionContext): Promise<Response> {
		if (!authenticated(request, env.ENGINE_TOKEN)) return unavailable(401);
		const path = new URL(request.url).pathname;
		if (
			!(path === '/seal' && request.method === 'POST') &&
			!(path === '/healthz' && request.method === 'GET')
		)
			return unavailable(404);
		const { SigningEngine: namespace } = ctx.exports as Cloudflare.Exports & {
			SigningEngine: DurableObjectNamespace<SigningEngine>;
		};
		const engine = placedObject(namespace, 'sign', env.SEAL_LOCATION_HINT);
		if (engine === null) return unavailable(503);
		return await engine.proxy(request);
	}
} satisfies ExportedHandler<EngineEnvironment>;
