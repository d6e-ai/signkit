import { resolveApiKeyApplication } from '$lib/application/api-keys/api-key-runtime';
import { createApiKeyHttpHandlers, type ApiKeyHttpHandlers } from '$lib/http/api-keys';

const handlers: ApiKeyHttpHandlers = createApiKeyHttpHandlers(resolveApiKeyApplication);

export const GET = handlers.list;
export const POST = handlers.create;
