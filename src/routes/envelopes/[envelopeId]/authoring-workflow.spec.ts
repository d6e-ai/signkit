import { describe, expect, it } from 'vitest';
import {
	authoringStepComplete,
	defaultWorkspaceTab,
	nextAuthoringTab,
	previousAuthoringTab,
	sendBlockReason,
	signersMissingPlacements,
	syncWorkspaceTab,
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

	it('defaults tracking tabs from envelope status, not leftover authoring tabs', () => {
		expect(defaultWorkspaceTab('draft')).toBe('documents');
		expect(defaultWorkspaceTab('ready')).toBe('documents');
		expect(defaultWorkspaceTab('sent')).toBe('status');
		expect(defaultWorkspaceTab('in_progress')).toBe('status');
		expect(defaultWorkspaceTab('declined')).toBe('status');
		expect(defaultWorkspaceTab('voided')).toBe('status');
		expect(defaultWorkspaceTab('expired')).toBe('status');
		expect(defaultWorkspaceTab('completed')).toBe('documents');
		expect(syncWorkspaceTab('documents', 'sent', false)).toBe('status');
		expect(syncWorkspaceTab('documents', 'completed', false)).toBe('documents');
		expect(syncWorkspaceTab('send', 'sent', true)).toBe('status');
		expect(syncWorkspaceTab('documents', 'sent', true)).toBe('documents');
		expect(syncWorkspaceTab('status', 'draft', true)).toBe('send');
	});

	it('marks authoring steps from saved work, not tab order', () => {
		expect(
			authoringStepComplete('documents', {
				status: 'draft',
				hasDocuments: true,
				fieldsComplete: false
			})
		).toBe(true);
		expect(
			authoringStepComplete('recipients', {
				status: 'draft',
				hasDocuments: true,
				fieldsComplete: false
			})
		).toBe(false);
		expect(
			authoringStepComplete('recipients', {
				status: 'ready',
				hasDocuments: true,
				fieldsComplete: false
			})
		).toBe(true);
		expect(
			authoringStepComplete('fields', {
				status: 'ready',
				hasDocuments: true,
				fieldsComplete: false
			})
		).toBe(false);
		expect(
			authoringStepComplete('fields', {
				status: 'ready',
				hasDocuments: true,
				fieldsComplete: true
			})
		).toBe(true);
		expect(
			authoringStepComplete('send', {
				status: 'ready',
				hasDocuments: true,
				fieldsComplete: true
			})
		).toBe(false);
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
