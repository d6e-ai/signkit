/** Display-only, authorized admin-list projection. Never an authorization input. */
export type MemberDisplay =
	| {
			state: 'available';
			name: string;
			email: string;
			observedAt: string;
			expiresAt: string;
	  }
	| { state: 'unavailable' };

/** A historical accepting member is distinct from the original invitation target. */
export type InvitationDisplay =
	| { state: 'pending'; email: string }
	| { state: 'accepted'; member: MemberDisplay }
	| { state: 'redacted' }
	| { state: 'unavailable' };
