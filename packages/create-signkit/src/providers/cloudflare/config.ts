import {
	ASSETS_BINDING,
	D1_BINDING,
	EMAIL_BINDING,
	R2_BINDING,
	SMTP_PASSWORD_SECRET
} from '../../constants.js';
import type { MailProviderId } from '../../cli/parse.js';
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
	mailProvider: MailProviderId;
	smtpHost?: string;
	smtpPort?: number;
	smtpSecure?: boolean;
	smtpUsername?: string;
	bootstrapOwnerEmail?: string;
	manifest: ReleaseManifest;
	main: string;
	assetsDirectory: string;
	migrationsDirectory: string;
}

export function renderWranglerConfig(input: WranglerConfigInput): string {
	const vars: Record<string, string> = {
		SIGNKIT_MAIL_PROVIDER: input.mailProvider
	};
	if (input.mailProvider === 'smtp') {
		if (input.smtpHost) vars.SIGNKIT_SMTP_HOST = input.smtpHost;
		if (input.smtpPort !== undefined) vars.SIGNKIT_SMTP_PORT = String(input.smtpPort);
		if (input.smtpSecure !== undefined) vars.SIGNKIT_SMTP_SECURE = String(input.smtpSecure);
		if (input.smtpUsername) vars.SIGNKIT_SMTP_USERNAME = input.smtpUsername;
	}
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
	if (input.bootstrapOwnerEmail) {
		vars.SIGNKIT_BOOTSTRAP_OWNER_EMAIL = input.bootstrapOwnerEmail;
	}
	const config = {
		name: input.workerName,
		main: input.main,
		workers_dev: !input.domain,
		...(input.domain ? { routes: [{ pattern: input.domain, custom_domain: true as const }] } : {}),
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
		...(input.mailProvider === 'cloudflare'
			? { send_email: [{ name: input.manifest.bindings.email || EMAIL_BINDING }] }
			: {}),
		vars,
		secrets: {
			required: [
				...input.manifest.requiredSecrets,
				...(input.mailProvider === 'smtp' && input.smtpUsername ? [SMTP_PASSWORD_SECRET] : [])
			]
		},
		triggers: { crons: ['* * * * *', '*/5 * * * *'] },
		observability: { enabled: true, head_sampling_rate: 1 }
	};
	return `${JSON.stringify(config, null, '\t')}\n`;
}
