export const AUTHORING_TABS = ['documents', 'recipients', 'fields', 'send'] as const;
export type AuthoringTab = (typeof AUTHORING_TABS)[number];

export function isAuthoringStatus(status: string | undefined): boolean {
	return status === 'draft' || status === 'ready';
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
