import { describe, expect, it } from 'vitest';
import {
	nextAuthoringTab,
	previousAuthoringTab,
	sendBlockReason,
	signersMissingPlacements,
	tabAfterRecipients
} from './authoring-workflow';

describe('authoring workflow helpers', () => {
	it('walks documents -> recipients -> fields -> review', () => {
		expect(nextAuthoringTab('documents')).toBe('recipients');
		expect(nextAuthoringTab('recipients')).toBe('fields');
		expect(nextAuthoringTab('fields')).toBe('send');
		expect(nextAuthoringTab('send')).toBeNull();
		expect(previousAuthoringTab('documents')).toBeNull();
		expect(previousAuthoringTab('recipients')).toBe('documents');
	});

	it('skips signature placement when nobody needs to sign', () => {
		expect(tabAfterRecipients(true)).toBe('fields');
		expect(tabAfterRecipients(false)).toBe('send');
	});

	it('names signers who still need a signature position', () => {
		expect(
			signersMissingPlacements(
				[{ id: 'signer-a' }, { id: 'signer-b' }],
				[{ recipientId: 'signer-a' }]
			)
		).toEqual(['signer-b']);
		expect(signersMissingPlacements([{ id: 'signer-a' }], [{ recipientId: 'signer-a' }])).toEqual(
			[]
		);
	});

	it('allows approval-only send without signature boxes', () => {
		expect(
			sendBlockReason({
				status: 'ready',
				hasUnsavedDocuments: false,
				hasUnsavedFields: false,
				fieldsHydrated: false,
				hasSigners: false,
				missingSignerIds: []
			})
		).toBeNull();
	});

	it('blocks send for unsaved work, locked hydration, or missing signer placements', () => {
		expect(
			sendBlockReason({
				status: 'draft',
				hasUnsavedDocuments: false,
				hasUnsavedFields: false,
				fieldsHydrated: true,
				hasSigners: true,
				missingSignerIds: []
			})
		).toBe('not-ready');
		expect(
			sendBlockReason({
				status: 'ready',
				hasUnsavedDocuments: true,
				hasUnsavedFields: false,
				fieldsHydrated: true,
				hasSigners: true,
				missingSignerIds: []
			})
		).toBe('unsaved-documents');
		expect(
			sendBlockReason({
				status: 'ready',
				hasUnsavedDocuments: false,
				hasUnsavedFields: true,
				fieldsHydrated: true,
				hasSigners: true,
				missingSignerIds: []
			})
		).toBe('unsaved-fields');
		expect(
			sendBlockReason({
				status: 'ready',
				hasUnsavedDocuments: false,
				hasUnsavedFields: false,
				fieldsHydrated: false,
				hasSigners: true,
				missingSignerIds: []
			})
		).toBe('hydration-locked');
		expect(
			sendBlockReason({
				status: 'ready',
				hasUnsavedDocuments: false,
				hasUnsavedFields: false,
				fieldsHydrated: true,
				hasSigners: true,
				missingSignerIds: ['signer-a']
			})
		).toBe('missing-placement');
	});
});
