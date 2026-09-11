// PostgreSQL `integer` is the narrowest generation column across supported
// profiles. Keeping the shared contract inside that range avoids a request
// that D1 accepts but PostgreSQL cannot persist.
export const MAX_DRAFT_GENERATION: number = 2_147_483_647;

export function normalizeMarkdownContent(content: string): string {
	return `${content.replace(/\r\n?/g, '\n').trimEnd()}\n`;
}
