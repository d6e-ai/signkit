import { describe, expect, it } from 'vitest';
import { isSettingsSurfacePath } from './settings-surface';

describe('settings surface route classification', () => {
	it.each([
		'/settings',
		'/en/settings',
		'/ja/settings',
		'/settings/members',
		'/settings/invitations',
		'/settings/api-keys'
	])('classifies %s as the settings surface', (pathname) =>
		expect(isSettingsSurfacePath(pathname)).toBe(true)
	);

	it.each(['/', '/en', '/agreements/new', '/api/v1/instance/members', '/sign'])(
		'keeps %s out of the settings surface',
		(pathname) => expect(isSettingsSurfacePath(pathname)).toBe(false)
	);
});
