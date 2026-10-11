import { describe, expect, it } from 'vitest';
import { openApiDocument } from './document';
import { completionAccessReissueBodySchema } from '$lib/http/completion-access-reissue';

interface OpenApiDocument {
	paths: Record<
		string,
		Record<
			string,
			{
				requestBody?: { content: { 'application/json': { schema: Record<string, unknown> } } };
				responses?: Record<string, { content?: { 'application/json': { schema: unknown } } }>;
			}
		>
	>;
	components: { schemas: Record<string, Record<string, unknown>> };
}

describe('OpenAPI completion access reissue schema contract (F5)', () => {
	const document = openApiDocument() as unknown as OpenApiDocument;
	const schemas = document.components.schemas;

	it('registers concrete named schemas for the listing and reissue responses', () => {
		for (const name of [
			'CurrentCompletionDeliveryItem',
			'CompletionDeliveriesResponse',
			'CompletionAccessReissueReceipt',
			'CompletionAccessReissueResponse'
		]) {
			expect(schemas[name], `Schema ${name} should be registered`).toBeDefined();
		}
	});

	it('describes every field of the listing item -- never a bare object', () => {
		const item = schemas.CurrentCompletionDeliveryItem;
		expect(item.additionalProperties).toBe(false);
		expect(item.required).toEqual(
			expect.arrayContaining([
				'deliveryId',
				'recipientId',
				'recipientRole',
				'generation',
				'status',
				'attempts',
				'accessExpiresAt',
				'accessRevokedAt',
				'deliveredAt',
				'failedAt',
				'errorCode',
				'failureCauseCode',
				'eligibleForReissue'
			])
		);
		const properties = item.properties as Record<string, { type?: unknown }>;
		expect(properties.failureCauseCode.type).toEqual(['string', 'null']);
		// Never a raw or sealed token, a claim lease, or any other grant material.
		for (const forbidden of ['sealedToken', 'claimToken', 'lockedAt', 'tokenHash']) {
			expect(properties[forbidden]).toBeUndefined();
		}
	});

	it('links the completion-deliveries GET and completion-access/reissue POST to the concrete named schemas, and both answer 404', () => {
		const listGet = document.paths['/api/v1/envelopes/{envelopeId}/completion-deliveries'].get;
		expect(listGet.responses?.['200']?.content?.['application/json'].schema).toEqual({
			$ref: '#/components/schemas/CompletionDeliveriesResponse'
		});
		expect(listGet.responses?.['404']).toBeDefined();

		const reissuePost =
			document.paths[
				'/api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue'
			].post;
		expect(reissuePost.responses?.['200']?.content?.['application/json'].schema).toEqual({
			$ref: '#/components/schemas/CompletionAccessReissueResponse'
		});
		expect(reissuePost.responses?.['404']).toBeDefined();
	});

	it("aligns expectedFailedAt's documented pattern with the server's actual accepted UTC-only subset", () => {
		const reissuePost =
			document.paths[
				'/api/v1/envelopes/{envelopeId}/recipients/{recipientId}/completion-access/reissue'
			].post;
		const requestProperties = reissuePost.requestBody?.content['application/json'].schema
			.properties as Record<string, { pattern?: string }>;
		const documentedPattern = new RegExp(requestProperties.expectedFailedAt.pattern ?? '');

		const validBody = (expectedFailedAt: string): Record<string, unknown> => ({
			grantAccess: true,
			expectedDeliveryId: '0191eb70-6523-74b2-b7b5-2fa75bb6d001',
			expectedAttempts: 10,
			expectedFailedAt,
			expectedErrorCode: 'delivery_attempts_exhausted'
		});

		for (const candidate of [
			'2026-09-11T00:05:00.000Z', // D1/postgres millisecond precision
			'2026-09-11T00:05:00.123456Z', // postgres microsecond precision
			'2026-09-11T00:05:00Z', // no fractional seconds at all
			'2026-09-11T00:05:00.1234567Z', // seven fractional digits: too many
			'2026-09-11T00:05:00.000+00:00', // numeric offset instead of Z
			'2026-09-11 00:05:00.000Z', // space instead of T
			'not-a-timestamp'
		]) {
			expect(documentedPattern.test(candidate), `pattern test(${candidate})`).toBe(
				completionAccessReissueBodySchema.safeParse(validBody(candidate)).success
			);
		}
	});
});
