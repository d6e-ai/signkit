import { json, type RequestHandler } from '@sveltejs/kit';
import { openApiDocument } from '$lib/openapi/document';

export const GET: RequestHandler = () =>
	json(openApiDocument(), { headers: { 'cache-control': 'no-store' } });
