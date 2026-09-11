import type { Element, Parent, Root, RootContent } from 'hast';
import type {
	Html,
	Image,
	ImageReference,
	Parent as MdastParent,
	RootContent as MdastRootContent,
	Text as MdastText
} from 'mdast';
import type { Schema } from 'hast-util-sanitize';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 50_000;

const ALLOWED_TAGS = [
	'a',
	'blockquote',
	'br',
	'code',
	'del',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'li',
	'ol',
	'p',
	'pre',
	'section',
	'strong',
	'sup',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul'
] as const;

const AUTO_DIRECTION_TAGS: ReadonlySet<string> = new Set([
	'blockquote',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'li',
	'p',
	'td',
	'th'
]);

export type RecipientMarkdownTag = (typeof ALLOWED_TAGS)[number];

export type RecipientMarkdownNode =
	| { type: 'text'; value: string }
	| {
			type: 'element';
			tag: RecipientMarkdownTag;
			attributes: Readonly<Record<string, string>>;
			children: readonly RecipientMarkdownNode[];
	  };

export interface RenderedRecipientMarkdown {
	nodes: readonly RecipientMarkdownNode[];
	hasVisibleUnicodeControls: boolean;
}

export class RecipientMarkdownRenderError extends Error {
	readonly code = 'RECIPIENT_MARKDOWN_RENDER_ERROR';

	constructor() {
		super('Recipient Markdown exceeds the safe rendering budget');
		this.name = 'RecipientMarkdownRenderError';
	}
}

// Ordinary Arabic and Hebrew characters are retained. Directional controls and
// selected invisible format characters are surfaced so they cannot silently
// reorder or conceal legal text in the formatted view.
const INVISIBLE_UNICODE_CONTROLS =
	/[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/gu;

// This intentionally replaces rehype-sanitize's default attributes and
// protocols with a smaller document-only surface.
const RECIPIENT_MARKDOWN_SCHEMA: Schema = {
	tagNames: [...ALLOWED_TAGS],
	attributes: {
		a: ['href', 'rel', 'target'],
		ol: ['start']
	},
	protocols: {
		href: ['https', 'mailto']
	}
};

export function renderRecipientMarkdown(source: string): RenderedRecipientMarkdown {
	if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
		throw new RecipientMarkdownRenderError();
	}

	const state: MarkdownNormalizationState = {
		hasVisibleUnicodeControls: false,
		nodeCount: 0
	};
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(normalizeMarkdownTree, state)
		.use(remarkRehype, { allowDangerousHtml: false })
		.use(hardenLinks)
		.use(rehypeSanitize, RECIPIENT_MARKDOWN_SCHEMA);
	const parsed = processor.parse(source);
	const sanitized: Root = processor.runSync(parsed) as Root;

	return {
		nodes: sanitized.children.flatMap(toRenderNode),
		hasVisibleUnicodeControls: state.hasVisibleUnicodeControls
	};
}

interface MarkdownNormalizationState {
	hasVisibleUnicodeControls: boolean;
	nodeCount: number;
}

function normalizeMarkdownTree(state: MarkdownNormalizationState): (tree: MdastParent) => void {
	return (tree: MdastParent): void => normalizeMarkdownParent(tree, state, 0);
}

function normalizeMarkdownParent(
	parent: MdastParent,
	state: MarkdownNormalizationState,
	depth: number
): void {
	if (depth > MAX_TREE_DEPTH) throw new RecipientMarkdownRenderError();

	parent.children = parent.children.map((child: MdastRootContent): MdastRootContent => {
		state.nodeCount += 1;
		if (state.nodeCount > MAX_TREE_NODES) throw new RecipientMarkdownRenderError();

		if (child.type === 'html') return htmlAsText(child, state);
		if (child.type === 'image' || child.type === 'imageReference') {
			return imagePlaceholder(child, state);
		}
		if (child.type === 'text' || child.type === 'code' || child.type === 'inlineCode') {
			child.value = surfaceUnicodeControls(child.value, state);
		}
		if (child.type === 'link' || child.type === 'definition') {
			child.url = surfaceUnicodeControls(child.url, state);
		}
		if (child.type === 'listItem' && typeof child.checked === 'boolean') {
			const marker: MdastText = { type: 'text', value: child.checked ? '[x] ' : '[ ] ' };
			const first = child.children[0];
			if (first?.type === 'paragraph') {
				first.children.unshift(marker);
				state.nodeCount += 1;
				if (state.nodeCount > MAX_TREE_NODES) throw new RecipientMarkdownRenderError();
			}
			delete child.checked;
		}
		if ('children' in child && Array.isArray(child.children)) {
			normalizeMarkdownParent(child as MdastParent, state, depth + 1);
		}
		return child;
	});
}

function htmlAsText(html: Html, state: MarkdownNormalizationState): MdastText {
	return { type: 'text', value: surfaceUnicodeControls(html.value, state) };
}

function imagePlaceholder(
	image: Image | ImageReference,
	state: MarkdownNormalizationState
): MdastText {
	const alt: string = surfaceUnicodeControls(image.alt?.trim() || 'no description', state);
	return { type: 'text', value: `⟦IMG: ${alt}⟧` };
}

function surfaceUnicodeControls(value: string, state: MarkdownNormalizationState): string {
	return value.replace(INVISIBLE_UNICODE_CONTROLS, (control: string): string => {
		state.hasVisibleUnicodeControls = true;
		return `⟦U+${control.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}⟧`;
	});
}

function hardenLinks(): (tree: Root) => void {
	return (tree: Root): void => hardenLinksInParent(tree);
}

function hardenLinksInParent(parent: Parent): void {
	const children: Parent['children'] = [];
	for (const child of parent.children) {
		if (child.type !== 'element') {
			children.push(child);
			continue;
		}

		hardenLinksInParent(child);
		if (child.tagName !== 'a') {
			children.push(child);
			continue;
		}

		const href: unknown = child.properties.href;
		if (typeof href !== 'string' || !isAllowedLink(href)) {
			children.push(...child.children);
			if (
				typeof href === 'string' &&
				href.length > 0 &&
				hastTextContent(child).trim() !== href.trim()
			) {
				children.push({ type: 'text', value: ` ⟦URL: ${href}⟧` });
			}
			continue;
		}

		const link: Element = child;
		link.properties =
			new URL(href, 'https://signkit.invalid').protocol === 'https:'
				? { href, target: '_blank', rel: ['noopener', 'noreferrer'] }
				: { href };
		children.push(link);
	}
	parent.children = children;
}

function hastTextContent(parent: Parent): string {
	return parent.children
		.map((child: RootContent): string => {
			if (child.type === 'text') return child.value;
			return child.type === 'element' ? hastTextContent(child) : '';
		})
		.join('');
}

function isAllowedLink(href: string): boolean {
	if (/^https:\/\//iu.test(href)) {
		try {
			return new URL(href).protocol === 'https:';
		} catch {
			return false;
		}
	}
	return /^mailto:[^\s@]+@[^\s@]+$/iu.test(href);
}

function toRenderNode(node: RootContent): RecipientMarkdownNode[] {
	if (node.type === 'text') return [{ type: 'text', value: node.value }];
	if (node.type !== 'element' || !isAllowedTag(node.tagName)) return [];

	const attributes: Record<string, string> = {};
	if (AUTO_DIRECTION_TAGS.has(node.tagName)) attributes.dir = 'auto';
	if (node.tagName === 'a') {
		for (const name of ['href', 'target', 'rel'] as const) {
			const value: unknown = node.properties[name];
			if (typeof value === 'string') attributes[name] = value;
			else if (Array.isArray(value)) attributes[name] = value.join(' ');
		}
	}
	if (node.tagName === 'ol') {
		const start: unknown = node.properties.start;
		if (typeof start === 'number' || typeof start === 'string') attributes.start = String(start);
	}

	return [
		{
			type: 'element',
			tag: node.tagName,
			attributes,
			children: node.children.flatMap(toRenderNode)
		}
	];
}

function isAllowedTag(tagName: string): tagName is RecipientMarkdownTag {
	return (ALLOWED_TAGS as readonly string[]).includes(tagName);
}
