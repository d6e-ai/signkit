import { bindings, defineConfig, defineContainer, exports } from 'cf/config';

function setting(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing deployment setting ${name}`);
	return value;
}

const prefix = setting('SEAL_WORKER_PREFIX');
if (!/^[a-z][a-z0-9-]{1,40}$/.test(prefix)) throw new Error('Invalid SEAL_WORKER_PREFIX');

const base = {
	compatibilityDate: '2026-11-18',
	compatibilityFlags: ['nodejs_compat'],
	previewUrls: false,
	observability: { enabled: true, logs: { invocationLogs: false } }
};

function policy() {
	return {
		SEAL_CERTIFICATE_SHA256: bindings.text(setting('SEAL_CERTIFICATE_SHA256')),
		SEAL_POLICY_ID: bindings.text(setting('SEAL_POLICY_ID')),
		VALIDATION_POLICY_ID: bindings.text(setting('VALIDATION_POLICY_ID'))
	};
}

function audience() {
	return {
		SEAL_ISSUER: bindings.text(setting('SEAL_ISSUER')),
		SEAL_AUDIENCE: bindings.text(setting('SEAL_AUDIENCE')),
		...policy()
	};
}

function configure() {
	const role = setting('SEAL_WORKER_ROLE');
	const name = `${prefix}-${role}`;
	switch (role) {
		case 'issuer':
			return defineConfig({
				worker: {
					...base,
					name,
					entrypoint: 'cloudflare/issuer.ts',
					workersDev: false,
					env: {
						...audience(),
						EVIDENCE_DB: bindings.d1({ id: setting('SEAL_EVIDENCE_DB_ID') }),
						EVIDENCE_OBJECTS: bindings.r2({ name: setting('SEAL_EVIDENCE_BUCKET') })
					}
				}
			});
		case 'gateway':
			return defineConfig({
				worker: {
					...base,
					name,
					entrypoint: 'gateway/index.ts',
					workersDev: true,
					env: {
						...audience(),
						SEAL_AUTHORIZATION_PUBLIC_KEY: bindings.text(setting('SEAL_AUTHORIZATION_PUBLIC_KEY')),
						ISSUER: bindings.worker({ worker: `${prefix}-issuer` }),
						ENGINE: bindings.worker({ worker: `${prefix}-engine` }),
						LEDGER: bindings.d1({ id: setting('SEAL_LEDGER_DB_ID') }),
						RESULTS: bindings.r2({ name: setting('SEAL_RESULT_BUCKET') })
					}
				}
			});
		case 'engine':
		case 'validator': {
			const signing = role === 'engine';
			const exportName = signing ? 'SigningEngine' : 'ValidationEngine';
			const image = defineContainer({
				name,
				schedulingPolicy: 'durable-object',
				images: { base: { dockerfile: `./${role}/Dockerfile` } },
				ssh: { enabled: false }
			});
			return defineConfig({
				containers: [image],
				worker: {
					...base,
					name,
					entrypoint: `cloudflare/${role}.ts`,
					workersDev: !signing,
					exports: { [exportName]: exports.durableObject({ storage: 'sqlite', container: image }) },
					env: {
						...(signing ? {} : policy()),
						...(signing && process.env.SEAL_KEY_BACKEND
							? { SEAL_KEY_BACKEND: bindings.text(setting('SEAL_KEY_BACKEND')) }
							: {})
					}
				}
			});
		}
		default:
			throw new Error('Unknown SEAL_WORKER_ROLE');
	}
}

export default configure();
