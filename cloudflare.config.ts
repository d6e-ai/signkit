import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
	worker: {
		name: 'signkit',
		compatibilityDate: '2026-09-11',
		compatibilityFlags: ['nodejs_compat'],
		entrypoint: 'cloudflare-worker.mjs',
		// cf beta has no keep-vars flag. Preserve dashboard-only vars and secrets
		// through the supported raw upload metadata until a typed option exists.
		unsafe: {
			metadata: {
				keep_bindings: ['plain_text', 'json', 'secret_text', 'secret_key']
			}
		},
		observability: {
			enabled: true,
			headSamplingRate: 1
		},
		triggers: [
			triggers.scheduled({
				schedule: '* * * * *'
			})
		],
		env: {
			SIGNKIT_MAIL_PROVIDER: bindings.text('cloudflare'),
			DB: bindings.d1({
				name: 'signkit',
				...(process.env.SIGNKIT_D1_DATABASE_ID ? { id: process.env.SIGNKIT_D1_DATABASE_ID } : {})
			}),
			OBJECTS: bindings.r2({
				name: 'signkit-objects'
			}),
			EMAIL: bindings.sendEmail({}),
			ASSETS: bindings.assets()
		}
	}
});
