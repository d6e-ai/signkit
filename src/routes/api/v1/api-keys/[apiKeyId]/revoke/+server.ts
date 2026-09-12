import { resolveApiKeyApplication } from '$lib/application/api-keys/api-key-runtime';
import { createApiKeyRevokeHandler } from '$lib/http/api-key-revoke';

export const POST = createApiKeyRevokeHandler(resolveApiKeyApplication);
