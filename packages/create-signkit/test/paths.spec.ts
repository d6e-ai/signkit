import { describe, expect, it } from 'vitest';
import { posixRelativeToRoot } from '../src/release/paths.js';

describe('posixRelativeToRoot', () => {
	it('emits relative POSIX paths and refuses escapes', () => {
		expect(posixRelativeToRoot('/bundle', '/bundle/worker/index.js', 'main')).toBe(
			'worker/index.js'
		);
		expect(() => posixRelativeToRoot('/bundle', '/elsewhere/index.js', 'main')).toThrow(
			/inside the bundle root/
		);
	});
});
