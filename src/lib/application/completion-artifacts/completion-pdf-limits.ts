/** Maximum size of a published completion PDF, including executed agreements. */
export const MAX_PUBLISHED_COMPLETION_PDF_BYTES: number = 32 * 1024 * 1024;

/**
 * The deterministic evidence summary is only an appendix to an executed
 * agreement. Keep its smaller bound independent from the final artifact.
 */
export const MAX_EVIDENCE_SUMMARY_PDF_BYTES: number = 8 * 1024 * 1024;
