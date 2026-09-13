import { resolveApiKeyApplication } from '$lib/application/api-keys/api-key-runtime';
import {
	createApiKeyOrganizationGrantHandlers,
	type ApiKeyOrganizationGrantHandlers
} from '$lib/http/api-key-organization-grants';

const handlers: ApiKeyOrganizationGrantHandlers =
	createApiKeyOrganizationGrantHandlers(resolveApiKeyApplication);

export const POST = handlers.revoke;
