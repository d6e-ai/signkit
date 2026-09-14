import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;

export const SIGNKIT_REPOSITORY = 'd6e-ai/signkit';
export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_DOWNLOAD_ORIGIN = 'https://github.com';

export const DEFAULT_WORKER_NAME = 'signkit';
export const DEFAULT_D1_NAME = 'signkit';
export const DEFAULT_R2_NAME = 'signkit-objects';
export const DEFAULT_CHANNEL = 'stable';
export const DEFAULT_VERSION = 'latest';
export const DEFAULT_D6E_AUTH_BASE_URL = 'https://www.d6e.ai';
export const DEFAULT_EMAIL_FROM_NAME = 'SignKit';

export const D1_BINDING = 'DB';
export const R2_BINDING = 'OBJECTS';
export const ASSETS_BINDING = 'ASSETS';
export const EMAIL_BINDING = 'EMAIL';

export const MANIFEST_ASSET_NAME = 'signkit-cloudflare-manifest.json';
export const BUNDLE_ASSET_PREFIX = 'signkit-cloudflare-';

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;
export const MAX_SMOKE_BYTES = 64 * 1024;
export const DEFAULT_SMOKE_ATTEMPTS = 3;
export const DEFAULT_SMOKE_BACKOFF_MS = 1000;
export const DEFAULT_SMOKE_TIMEOUT_MS = 10_000;
export const MAX_WRANGLER_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_EXTRACT_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_EXTRACT_ENTRIES = 10_000;
export const BACKUP_DIR_MODE = 0o700;
export const BACKUP_FILE_MODE = 0o600;

export const GITHUB_ALLOWED_HOSTS = new Set([
	'api.github.com',
	'github.com',
	'objects.githubusercontent.com',
	'release-assets.githubusercontent.com',
	'github-releases.githubusercontent.com'
]);

export const REQUIRED_WORKER_SECRETS = [
	'DELIVERY_ENCRYPTION_KEY',
	'SESSION_ENCRYPTION_KEY',
	'DELIVERY_WORKER_SECRET',
	'D6E_AUTH_CLIENT_ID',
	'D6E_AUTH_CLIENT_SECRET'
] as const;

export const REQUIRED_WORKER_VARS = [
	'D6E_AUTH_BASE_URL',
	'SIGNKIT_PUBLIC_ORIGIN',
	'SIGNKIT_EMAIL_FROM',
	'SIGNKIT_EMAIL_FROM_NAME',
	'SIGNKIT_MAIL_PROVIDER'
] as const;

export const SECRET_ENV_NAME =
	/^(?:.+_)?(?:SECRET|TOKEN|PASSWORD|PASS|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)(?:_.+)?$/i;

export const SECRET_FLAG_NAMES = new Set([
	'token',
	'api-token',
	'api-key',
	'secret',
	'password',
	'auth',
	'credentials'
]);

export const PROVIDER_FLAGS = {
	cloudflare: 'cloudflare',
	node: 'node',
	vercel: 'vercel'
} as const;

export const COMMANDS = ['plan', 'deploy', 'adopt', 'upgrade'] as const;

export const MIGRATION_POLICY_COMPATIBILITY =
	'forward-and-backward-compatible-within-released-versions' as const;

export const MIGRATION_POLICY_NOTES =
	'Released D1 migrations are additive and must remain backward-compatible with the previous released Worker. create-signkit applies pending migrations before uploading a new Worker version so the still-serving previous Worker can run on the new schema. Worker rollback cannot roll back D1. Do not restore SQL by rolling back a Worker.';
