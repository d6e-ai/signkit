import { describe, expect, it } from 'vitest';
import { assertEnvelopeMutable, assertMarkdownPath, canTransitionEnvelope } from './envelope';

describe('envelope policy', () => {
	it('allows the happy-path lifecycle', () => {
		expect(canTransitionEnvelope('draft', 'ready')).toBe(true);
		expect(canTransitionEnvelope('ready', 'sent')).toBe(true);
		expect(canTransitionEnvelope('sent', 'completed')).toBe(true);
	});

	it('freezes sent and terminal envelopes', () => {
		expect(() => assertEnvelopeMutable('sent')).toThrow(/immutable/);
		expect(canTransitionEnvelope('completed', 'draft')).toBe(false);
	});

	it('accepts only Markdown document paths', () => {
		expect(() => assertMarkdownPath('documents/master-service-agreement.md')).not.toThrow();
		expect(() => assertMarkdownPath('../secret.md')).toThrow(/Markdown/);
		expect(() => assertMarkdownPath('documents/source.docx')).toThrow(/Markdown/);
	});
});
