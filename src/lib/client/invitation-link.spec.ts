import { describe, expect, it, vi } from 'vitest';
import { clearInvitationLink, readInvitationLink } from './invitation-link';
const token = `ski1_${'a'.repeat(43)}`;
function browser(hash = '') {
	const values = new Map<string, string>();
	return {
		location: { hash, pathname: '/ja/invitations/accept', search: '' },
		history: { state: { preserved: true }, replaceState: vi.fn() },
		sessionStorage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key)
		}
	} as unknown as Pick<Window, 'location' | 'history' | 'sessionStorage'>;
}
describe('invitation email link handoff', () => {
	it('removes the fragment and restores the same token after OAuth without extending its lifetime', () => {
		const tab = browser(`#token=${token}`);
		expect(readInvitationLink(tab, 1000)).toBe(token);
		expect(tab.history.replaceState).toHaveBeenCalledWith(
			{ preserved: true },
			'',
			'/ja/invitations/accept'
		);
		tab.location.hash = '';
		expect(readInvitationLink(tab, 2000)).toBe(token);
		expect(readInvitationLink(tab, 601000)).toBeNull();
	});
	it('clears the handoff on success', () => {
		const tab = browser(`#token=${token}`);
		readInvitationLink(tab, 1000);
		clearInvitationLink(tab);
		tab.location.hash = '';
		expect(readInvitationLink(tab, 2000)).toBeNull();
	});
	it('rejects a malformed replacement link instead of reusing an older token', () => {
		const tab = browser(`#token=${token}`);
		readInvitationLink(tab, 1000);
		tab.location.hash = '#token=invalid';
		expect(readInvitationLink(tab, 2000)).toBeNull();
		tab.location.hash = '';
		expect(readInvitationLink(tab, 3000)).toBeNull();
	});
	it('allows in-memory acceptance when storage is blocked', () => {
		const tab = browser(`#token=${token}`);
		vi.spyOn(tab.sessionStorage, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		expect(readInvitationLink(tab, 1000)).toBe(token);
		tab.location.hash = '';
		expect(readInvitationLink(tab, 2000)).toBeNull();
	});
	it('treats corrupt storage as a missing invitation', () => {
		const tab = browser();
		vi.spyOn(tab.sessionStorage, 'getItem').mockReturnValue('{');
		expect(readInvitationLink(tab, 1000)).toBeNull();
	});
});
