import { describe, expect, it } from 'vitest';
import { acceptAuthoringFields, parseAuthoringFieldsResponse } from './authoring-fields';
import type { AuthoringFieldsResponse } from '$lib/client/envelopes';

const envelopeId = '01900000-0000-7000-8000-000000000001';
const matchingRevision = { generation: 1, fieldGeneration: 2, commitSha: null };

const fieldId = '01900000-0000-7000-8000-000000000010';
const recipientId = '01900000-0000-7000-8000-000000000011';
const documentId = '01900000-0000-7000-8000-000000000012';
const authoringFieldType = 'signature' as const;
const field = {
	id: fieldId,
	recipientId,
	documentId,
	documentPath: 'documents/agreement.md' as const,
	fieldType: authoringFieldType
};
const fieldLabel = 'Sign here';
const fieldGeometry = { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
const fullField = {
	...field,
	label: fieldLabel,
	required: true,
	position: 1,
	geometry: fieldGeometry
};

function matchingResponse(
	overrides: Partial<AuthoringFieldsResponse> = {}
): AuthoringFieldsResponse {
	return {
		envelopeId,
		generation: matchingRevision.generation,
		fieldGeneration: matchingRevision.fieldGeneration,
		commitSha: matchingRevision.commitSha,
		fields: [fullField],
		...overrides
	};
}

const expectedRecord = {
	id: fieldId,
	recipientId,
	documentId,
	documentPath: 'documents/agreement.md',
	fieldType: authoringFieldType,
	label: fieldLabel,
	required: true,
	position: 1,
	geometry: fieldGeometry
};

const publicField = {
	id: fieldId,
	recipientId,
	documentId,
	documentPath: 'documents/agreement.md' as const,
	fieldType: authoringFieldType,
	required: true,
	position: 1,
	geometry: fieldGeometry
};

const knownLinks = {
	recipientIds: new Set([recipientId]),
	documentIds: new Set([documentId])
};

const otherFieldId = '01900000-0000-7000-8000-000000000013';
const otherRecipientId = '01900000-0000-7000-8000-000000000014';

describe('acceptAuthoringFields', () => {
	it('accepts a response that matches the envelope, revision, and public field set exactly', () => {
		const records = acceptAuthoringFields(
			matchingResponse(),
			envelopeId,
			matchingRevision,
			[publicField],
			knownLinks
		);
		expect(records).toEqual([expectedRecord]);
	});

	it('accepts an empty field set only when the public projection is also empty', () => {
		const records = acceptAuthoringFields(
			matchingResponse({ fields: [] }),
			envelopeId,
			matchingRevision,
			[]
		);
		expect(records).toEqual([]);
	});

	it('preserves an empty label rather than inventing a default', () => {
		const records = acceptAuthoringFields(
			matchingResponse({ fields: [{ ...fullField, label: '' }] }),
			envelopeId,
			matchingRevision,
			[publicField],
			knownLinks
		);
		expect(records).toEqual([{ ...expectedRecord, label: '' }]);
	});

	it('keeps fields that predate geometric placement instead of dropping them', () => {
		const records = acceptAuthoringFields(
			matchingResponse({
				fields: [{ ...fullField, documentId: null, documentPath: null, geometry: null }]
			}),
			envelopeId,
			matchingRevision,
			[{ ...publicField, documentId: null, documentPath: null, geometry: null }],
			knownLinks
		);
		expect(records).toEqual([
			{
				...expectedRecord,
				documentId: null,
				documentPath: null,
				geometry: null
			}
		]);
	});

	const otherEnvelopeId = '01900000-0000-7000-8000-000000000099';

	it('rejects an envelope id mismatch rather than returning a partial set', () => {
		const mismatched = matchingResponse({ envelopeId: otherEnvelopeId });
		expect(
			acceptAuthoringFields(mismatched, envelopeId, matchingRevision, [publicField], knownLinks)
		).toBeNull();
	});

	it('rejects a generation mismatch rather than returning a partial set', () => {
		const mismatched = matchingResponse({ generation: matchingRevision.generation + 1 });
		expect(
			acceptAuthoringFields(mismatched, envelopeId, matchingRevision, [publicField], knownLinks)
		).toBeNull();
	});

	it('rejects a field generation mismatch rather than returning a partial set', () => {
		const mismatched = matchingResponse({
			fieldGeneration: matchingRevision.fieldGeneration + 1
		});
		expect(
			acceptAuthoringFields(mismatched, envelopeId, matchingRevision, [publicField], knownLinks)
		).toBeNull();
	});

	const otherCommitSha = 'different-commit';

	it('rejects a commit sha mismatch rather than returning a partial set', () => {
		const mismatched = matchingResponse({ commitSha: otherCommitSha });
		expect(
			acceptAuthoringFields(mismatched, envelopeId, matchingRevision, [publicField], knownLinks)
		).toBeNull();
	});

	it('rejects a malformed field rather than returning the well-formed prefix', () => {
		const mixed = matchingResponse({
			fields: [fullField, { ...fullField, id: otherFieldId, label: undefined as unknown as string }]
		});
		expect(
			acceptAuthoringFields(
				mixed,
				envelopeId,
				matchingRevision,
				[publicField, { ...publicField, id: otherFieldId }],
				knownLinks
			)
		).toBeNull();
	});

	it('rejects a subset that omits a public field rather than hydrating the remainder', () => {
		expect(
			acceptAuthoringFields(
				matchingResponse({ fields: [fullField] }),
				envelopeId,
				matchingRevision,
				[publicField, { ...publicField, id: otherFieldId, position: 2 }],
				knownLinks
			)
		).toBeNull();
	});

	it('rejects duplicate field ids rather than collapsing them', () => {
		expect(
			acceptAuthoringFields(
				matchingResponse({ fields: [fullField, { ...fullField }] }),
				envelopeId,
				matchingRevision,
				[publicField, { ...publicField, id: otherFieldId }],
				knownLinks
			)
		).toBeNull();
	});

	it('rejects a recipient or document link that is not on the current envelope', () => {
		expect(
			acceptAuthoringFields(
				matchingResponse({ fields: [{ ...fullField, recipientId: otherRecipientId }] }),
				envelopeId,
				matchingRevision,
				[{ ...publicField, recipientId: otherRecipientId }],
				knownLinks
			)
		).toBeNull();
	});
});

describe('parseAuthoringFieldsResponse', () => {
	it('parses a complete authoring payload', () => {
		expect(parseAuthoringFieldsResponse(matchingResponse())).toEqual(matchingResponse());
	});

	it('rejects a truncated body instead of hydrating an empty set', () => {
		expect(parseAuthoringFieldsResponse({ envelopeId, generation: 1 })).toBeNull();
	});

	it('rejects a non-array fields value rather than coercing it', () => {
		expect(parseAuthoringFieldsResponse({ ...matchingResponse(), fields: null })).toBeNull();
	});
});
