import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cmapsSrc = resolve(root, 'node_modules/pdfjs-dist/cmaps');
const cmapsDest = resolve(root, 'static/pdfjs/cmaps');
const fontsSrc = resolve(root, 'node_modules/pdfjs-dist/standard_fonts');
const fontsDest = resolve(root, 'static/pdfjs/standard_fonts');
const licenseSrc = resolve(root, 'node_modules/pdfjs-dist/LICENSE');
const licenseDest = resolve(root, 'static/pdfjs/LICENSE');

for (const source of [cmapsSrc, fontsSrc, licenseSrc]) {
	if (!existsSync(source)) {
		throw new Error(`Missing pdfjs-dist runtime asset: ${source}`);
	}
}

mkdirSync(cmapsDest, { recursive: true });
mkdirSync(fontsDest, { recursive: true });
cpSync(cmapsSrc, cmapsDest, { recursive: true });
cpSync(fontsSrc, fontsDest, { recursive: true });
cpSync(licenseSrc, licenseDest);
