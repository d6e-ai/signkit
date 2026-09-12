import { describe, expect, it } from 'vitest';
import {
	RecipientMarkdownRenderError,
	renderRecipientMarkdown,
	type RecipientMarkdownNode
} from './recipient-markdown';

describe('recipient Markdown rendering', () => {
	it('renders a constrained CommonMark and GFM table surface', () => {
		const rendered = renderRecipientMarkdown(
			'# Agreement\n\n**Important** and *emphasized*.\n\n| Item | Value |\n| --- | --- |\n| Fee | 100 |'
		);

		expect(findElements(rendered.nodes, 'h1')).toHaveLength(1);
		expect(findElements(rendered.nodes, 'strong')).toHaveLength(1);
		expect(findElements(rendered.nodes, 'table')).toHaveLength(1);
		expect(textContent(rendered.nodes)).toContain('Fee');
		expect(textContent(rendered.nodes)).toContain('100');
	});

	it('renders raw and malformed HTML as text instead of making it active', () => {
		const rendered = renderRecipientMarkdown(
			'<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n<div><svg><script>alert(3)</script>'
		);

		expect(findElements(rendered.nodes, 'script')).toHaveLength(0);
		expect(findElements(rendered.nodes, 'img')).toHaveLength(0);
		expect(textContent(rendered.nodes)).toContain('<script>alert(1)</script>');
		expect(textContent(rendered.nodes)).toContain('<img src=x onerror=alert(2)>');
	});

	it('allows only HTTPS and mailto links and preserves rejected destinations as text', () => {
		const rendered = renderRecipientMarkdown(
			'[secure](https://example.com/path) [mail](mailto:legal@example.com) [http](http://example.com) [script](javascript:alert(1)) [data](data:text/html,test) [relative](/admin) [scheme relative](//example.com)'
		);
		const links = findElements(rendered.nodes, 'a');

		expect(links).toHaveLength(2);
		expect(links[0]?.attributes).toEqual({
			href: 'https://example.com/path',
			target: '_blank',
			rel: 'noopener noreferrer'
		});
		expect(links[1]?.attributes).toEqual({ href: 'mailto:legal@example.com' });
		expect(textContent(rendered.nodes)).toContain('⟦URL: http://example.com⟧');
		expect(textContent(rendered.nodes)).toContain('⟦URL: javascript:alert(1)⟧');
		expect(textContent(rendered.nodes)).toContain('⟦URL: /admin⟧');
	});

	it('replaces remote images with inert alt text', () => {
		const rendered = renderRecipientMarkdown(
			'Before ![signature preview](https://tracker.example/pixel.gif) after'
		);

		expect(textContent(rendered.nodes)).toContain('⟦IMG: signature preview⟧');
		expect(findElements(rendered.nodes, 'img')).toHaveLength(0);
		expect(JSON.stringify(rendered.nodes)).not.toContain('tracker.example');
	});

	it('retains task-list state without emitting form controls', () => {
		const rendered = renderRecipientMarkdown('- [x] Accepted\n- [ ] Pending');

		expect(textContent(rendered.nodes)).toContain('[x] Accepted');
		expect(textContent(rendered.nodes)).toContain('[ ] Pending');
		expect(findElements(rendered.nodes, 'input')).toHaveLength(0);
	});

	it('preserves the explicit start number of an ordered clause list', () => {
		const rendered = renderRecipientMarkdown('3. Third clause\n4. Fourth clause');

		expect(findElements(rendered.nodes, 'ol')).toHaveLength(1);
		expect(findElements(rendered.nodes, 'ol')[0]?.attributes).toEqual({ start: '3' });
	});

	it('surfaces invisible Unicode controls in prose and code while retaining ordinary RTL text', () => {
		const rendered = renderRecipientMarkdown(
			'English \u202E spoof \u2066 text\n\n`inline\u200Fcode`\n\n```\nblock\u2067code\n```\n\nمرحبا بالعالم'
		);

		expect(rendered.hasVisibleUnicodeControls).toBe(true);
		expect(textContent(rendered.nodes)).toContain('⟦U+202E⟧');
		expect(textContent(rendered.nodes)).toContain('⟦U+2066⟧');
		expect(textContent(rendered.nodes)).toContain('inline⟦U+200F⟧code');
		expect(textContent(rendered.nodes)).toContain('block⟦U+2067⟧code');
		expect(textContent(rendered.nodes)).toContain('مرحبا بالعالم');
		expect(findElements(rendered.nodes, 'p').at(-1)?.attributes).toEqual({ dir: 'auto' });
	});

	it('handles a very long valid line without truncating its legal text', () => {
		const line: string = 'contract-term '.repeat(20_000);
		const rendered = renderRecipientMarkdown(line);

		expect(textContent(rendered.nodes).match(/contract-term/gu)).toHaveLength(20_000);
	});

	it('rejects source and syntax trees outside the rendering budget', () => {
		expect(() => renderRecipientMarkdown('a'.repeat(512 * 1024 + 1))).toThrow(
			RecipientMarkdownRenderError
		);
		expect(() => renderRecipientMarkdown(`${'> '.repeat(66)}deep`)).toThrow(
			RecipientMarkdownRenderError
		);
		expect(() => renderRecipientMarkdown('item\n\n'.repeat(26_000))).toThrow(
			RecipientMarkdownRenderError
		);
	});
});

function findElements(
	nodes: readonly RecipientMarkdownNode[],
	tag: string
): Array<Extract<RecipientMarkdownNode, { type: 'element' }>> {
	const matches: Array<Extract<RecipientMarkdownNode, { type: 'element' }>> = [];
	for (const node of nodes) {
		if (node.type !== 'element') continue;
		if (node.tag === tag) matches.push(node);
		matches.push(...findElements(node.children, tag));
	}
	return matches;
}

function textContent(nodes: readonly RecipientMarkdownNode[]): string {
	return nodes
		.map((node): string => (node.type === 'text' ? node.value : textContent(node.children)))
		.join('');
}
