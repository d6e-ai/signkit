import { ASSETS_BINDING, D1_BINDING, EMAIL_BINDING, R2_BINDING } from '../../constants.js';
import type { ReleaseManifest } from '../../release/manifest.js';

export interface WranglerConfigInput {
	workerName: string;
	d1Name: string;
	d1Id: string;
	r2Name: string;
	domain?: string;
	publicOrigin?: string;
	d6eAuthBaseUrl?: string;
	emailFrom?: string;
	emailFromName?: string;
	manifest: ReleaseManifest;
	main: string;
	assetsDirectory: string;
	migrationsDirectory: string;
}

export function renderWranglerConfig(input: WranglerConfigInput): string {
	const vars: Record<string, string> = {
		SIGNKIT_MAIL_PROVIDER: 'cloudflare'
	};
	if (input.publicOrigin) {
		vars.SIGNKIT_PUBLIC_ORIGIN = input.publicOrigin;
	}
	if (input.d6eAuthBaseUrl) {
		vars.D6E_AUTH_BASE_URL = input.d6eAuthBaseUrl;
	}
	if (input.emailFrom) {
		vars.SIGNKIT_EMAIL_FROM = input.emailFrom;
	}
	if (input.emailFromName) {
		vars.SIGNKIT_EMAIL_FROM_NAME = input.emailFromName;
	}
	const config = {
		name: input.workerName,
		main: input.main,
		compatibility_date: input.manifest.worker.compatibilityDate,
		compatibility_flags: input.manifest.worker.compatibilityFlags,
		assets: {
			directory: input.assetsDirectory,
			binding: input.manifest.bindings.assets || ASSETS_BINDING
		},
		d1_databases: [
			{
				binding: input.manifest.bindings.d1 || D1_BINDING,
				database_name: input.d1Name,
				database_id: input.d1Id,
				migrations_dir: input.migrationsDirectory
			}
		],
		r2_buckets: [
			{
				binding: input.manifest.bindings.r2 || R2_BINDING,
				bucket_name: input.r2Name
			}
		],
		send_email: [{ name: input.manifest.bindings.email || EMAIL_BINDING }],
		vars,
		triggers: { crons: ['* * * * *'] },
		observability: { enabled: true, head_sampling_rate: 1 }
	};
	return `${JSON.stringify(config, null, '\t')}\n`;
}
