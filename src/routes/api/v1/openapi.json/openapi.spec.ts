import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { openApiDocument } from '$lib/openapi/document';

function createEvent(): RequestEvent {
	return {
		request: new Request('https://signkit.example/api/v1/openapi.json'),
		url: new URL('https://signkit.example/api/v1/openapi.json')
	} as unknown as RequestEvent;
}

describe('GET /api/v1/openapi.json', () => {
	it('serves OpenAPI 3.1 for the live /api/v1 surface without secrets', async () => {
		const response = await GET(createEvent());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');

		const document = (await response.json()) as Record<string, unknown>;
		expect(document).toEqual(openApiDocument());
		expect(document.openapi).toBe('3.1.0');
		expect((document.info as { version: string }).version).toBe('v1');

		const paths = document.paths as Record<string, unknown>;
		for (const path of [
			'/api/v1/system/capabilities',
			'/api/v1/openapi.json',
			'/api/v1/contacts',
			'/api/v1/contacts/search',
			'/api/v1/contacts/{contactId}',
			'/api/v1/envelopes',
			'/api/v1/envelopes/{envelopeId}/draft/commits',
			'/api/v1/envelopes/{envelopeId}/draft/docx',
			'/api/v1/envelopes/{envelopeId}/docx',
			'/api/v1/envelopes/{envelopeId}/ready',
			'/api/v1/envelopes/{envelopeId}/fields',
			'/api/v1/envelopes/{envelopeId}/send',
			'/api/v1/envelopes/{envelopeId}/void',
			'/api/v1/envelopes/{envelopeId}/completion-artifact',
			'/api/v1/envelopes/{envelopeId}/evidence',
			'/api/v1/envelopes/{envelopeId}/completion-artifact/evidence',
			'/api/v1/envelopes/{envelopeId}/pdf',
			'/api/v1/envelopes/{envelopeId}/completion-artifact/pdf',
			'/api/v1/envelopes/{envelopeId}/reissue',
			'/api/v1/envelopes/{envelopeId}/recipients/{recipientId}/reissue',
			'/api/v1/signing/signature-assets',
			'/api/v1/completion-artifacts',
			'/api/v1/webhooks',
			'/api/v1/webhooks/{webhookId}/revoke',
			'/api/v1/system/webhooks/drain',
			'/api/v1/system/objects/orphan-sweep',
			'/api/v1/instance/invitations/accept'
		]) {
			expect(paths[path]).toBeDefined();
		}

		const components = document.components as {
			schemas: {
				ProblemDetail: { required: string[] };
				Contact: {
					required: string[];
					additionalProperties: boolean;
					properties: Record<string, unknown> & { version: { maximum: number } };
				};
			};
		};
		expect(components.schemas.ProblemDetail.required).toEqual(
			expect.arrayContaining(['type', 'title', 'status', 'detail', 'instance'])
		);
		expect(components.schemas.Contact.required).toEqual(
			expect.arrayContaining(['id', 'email', 'name', 'locale', 'version', 'createdAt', 'updatedAt'])
		);
		expect(components.schemas.Contact.additionalProperties).toBe(false);
		expect(components.schemas.Contact.properties.version.maximum).toBe(2_147_483_647);
		expect(components.schemas.Contact.properties).not.toHaveProperty('ownerUserId');
		expect(components.schemas.Contact.properties).not.toHaveProperty('organizationId');

		const serialized = JSON.stringify(document);
		expect(serialized).not.toContain('repositoryArchiveKey');
		expect(serialized).not.toContain('DELIVERY_WORKER_SECRET');
		expect(serialized).not.toContain('skwh1_');
		expect(serialized).not.toContain('SESSION_ENCRYPTION_KEY');
		expect(serialized).not.toContain('CLOUDFLARE_EMAIL_API_TOKEN');

		const envelopeSchema = (
			document.components as {
				schemas: {
					Envelope: { additionalProperties: boolean; properties: Record<string, unknown> };
				};
			}
		).schemas.Envelope;
		expect(envelopeSchema.additionalProperties).toBe(false);
		expect(envelopeSchema.properties).not.toHaveProperty('repositoryArchiveKey');
	});
});
