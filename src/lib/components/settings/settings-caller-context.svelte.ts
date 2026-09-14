import {
	createInstanceManagementClient,
	InstanceManagementApiError,
	type InstanceCallerContext
} from '$lib/client/instance-management';

/**
 * Loads the caller's own instance membership once and exposes it reactively.
 * Every settings route mounts its own instance of this class, so navigating
 * between `/settings/members`, `/settings/invitations`, and `/settings/api-keys`
 * always re-derives authorization from a fresh request rather than trusting a
 * stale cross-route cache.
 */
export class SettingsCallerContext {
	private readonly client = createInstanceManagementClient();

	initialLoading: boolean = $state(true);
	authRequired: boolean = $state(false);
	callerContext: InstanceCallerContext | null = $state(null);
	globalError: string | null = $state(null);

	async load(): Promise<void> {
		this.initialLoading = true;
		this.globalError = null;
		this.authRequired = false;
		try {
			this.callerContext = await this.client.getCurrentMember();
		} catch (err: unknown) {
			if (err instanceof InstanceManagementApiError && err.status === 401) {
				this.authRequired = true;
			} else {
				this.globalError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			this.initialLoading = false;
		}
	}
}

export function createSettingsCallerContext(): SettingsCallerContext {
	return new SettingsCallerContext();
}
