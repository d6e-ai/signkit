export const AUTHORING_TABS = ['documents', 'recipients', 'fields', 'send'] as const;
export type AuthoringTab = (typeof AUTHORING_TABS)[number];
export type TrackingTab = 'status' | 'documents';
export type WorkspaceTab = AuthoringTab | TrackingTab;

export function isAuthoringStatus(status: string | undefined): boolean {
	return status === 'draft' || status === 'ready';
}

export function isAuthoringTab(tab: string): tab is AuthoringTab {
	return (AUTHORING_TABS as readonly string[]).includes(tab);
}

export function authoringTabIndex(tab: AuthoringTab): number {
	return AUTHORING_TABS.indexOf(tab);
}

export function nextAuthoringTab(tab: AuthoringTab): AuthoringTab | null {
	const index = authoringTabIndex(tab);
	return index >= 0 && index < AUTHORING_TABS.length - 1 ? AUTHORING_TABS[index + 1] : null;
}

export function previousAuthoringTab(tab: AuthoringTab): AuthoringTab | null {
	const index = authoringTabIndex(tab);
	return index > 0 ? AUTHORING_TABS[index - 1] : null;
}

export function tabAfterRecipients(hasSigners: boolean): AuthoringTab {
	return hasSigners ? 'fields' : 'send';
}

export function defaultWorkspaceTab(status: string | undefined): WorkspaceTab {
	if (status === 'completed') return 'documents';
	if (status !== undefined && !isAuthoringStatus(status)) return 'status';
	return 'documents';
}

export function syncWorkspaceTab(
	current: WorkspaceTab,
	status: string | undefined,
	initialized: boolean
): WorkspaceTab {
	if (!initialized) return defaultWorkspaceTab(status);
	if (isAuthoringStatus(status)) return current === 'status' ? 'send' : current;
	if (current === 'recipients' || current === 'fields' || current === 'send') {
		return defaultWorkspaceTab(status);
	}
	return current;
}

export function authoringStepComplete(
	step: AuthoringTab,
	input: {
		status: string | undefined;
		hasDocuments: boolean;
		fieldsComplete: boolean;
	}
): boolean {
	switch (step) {
		case 'documents':
			return input.hasDocuments;
		case 'recipients':
			return input.status === 'ready';
		case 'fields':
			return input.status === 'ready' && input.fieldsComplete;
		case 'send':
			return false;
	}
}

export interface SignerPlacementInput {
	id: string;
}

export interface PlacedFieldInput {
	recipientId: string;
}

export function signersMissingPlacements(
	signers: readonly SignerPlacementInput[],
	fields: readonly PlacedFieldInput[]
): readonly string[] {
	const placed = new Set(fields.map((field) => field.recipientId));
	return signers.filter((signer) => !placed.has(signer.id)).map((signer) => signer.id);
}

export type SendBlockReason =
	| 'not-ready'
	| 'unsaved-documents'
	| 'unsaved-fields'
	| 'hydration-locked'
	| 'missing-placement'
	| null;

export function sendBlockReason(input: {
	status: string | undefined;
	hasUnsavedDocuments: boolean;
	hasUnsavedFields: boolean;
	fieldsHydrated: boolean;
	hasSigners: boolean;
	missingSignerIds: readonly string[];
}): SendBlockReason {
	if (input.status !== 'ready') return 'not-ready';
	if (input.hasUnsavedDocuments) return 'unsaved-documents';
	if (input.hasSigners && !input.fieldsHydrated) return 'hydration-locked';
	if (input.hasUnsavedFields) return 'unsaved-fields';
	if (input.hasSigners && input.missingSignerIds.length > 0) return 'missing-placement';
	return null;
}
