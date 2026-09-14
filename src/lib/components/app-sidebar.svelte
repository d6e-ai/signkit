<script lang="ts">
	import { page } from '$app/state';
	import { mergeProps } from 'bits-ui';
	import {
		IconAdjustmentsHorizontal,
		IconBolt,
		IconChevronRight,
		IconFileText,
		IconKey,
		IconLayoutDashboard,
		IconLogout,
		IconMailForward,
		IconPlus,
		IconSelector,
		IconUsers
	} from '@tabler/icons-svelte';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { deLocalizeHref, localizeHref } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';
	import type { InstanceMemberRole } from '$lib/ports/instance-store';

	let {
		name,
		email,
		instanceMemberRole
	}: {
		name: string | null;
		email: string | null;
		instanceMemberRole: InstanceMemberRole | null;
	} = $props();

	const items = $derived([
		{ title: m.nav_dashboard(), href: '/', icon: IconLayoutDashboard },
		{ title: m.nav_agreements(), href: '/envelopes', icon: IconFileText }
	]);
	const settingsItems = $derived([
		{ title: m.settings_tab_members(), href: '/settings/members', icon: IconUsers },
		{ title: m.settings_tab_invitations(), href: '/settings/invitations', icon: IconMailForward },
		{ title: m.settings_tab_api_keys(), href: '/settings/api-keys', icon: IconKey }
	]);
	// Members/Invitations administer the whole instance, so only an
	// owner/admin sees them. API keys are scoped to the caller's own account,
	// so any active member sees that one link. A non-active member or
	// non-member has no usable child route at all, so the whole menu
	// disappears rather than expanding to reveal nothing.
	const visibleSettingsItems = $derived.by(() => {
		if (instanceMemberRole === 'owner' || instanceMemberRole === 'admin') return settingsItems;
		if (instanceMemberRole === 'member') {
			return settingsItems.filter((item) => item.href === '/settings/api-keys');
		}
		return [];
	});
	const currentPath = $derived(deLocalizeHref(page.url.pathname));
	const onSettingsRoute = $derived(currentPath.startsWith('/settings'));
	const sidebar = Sidebar.useSidebar();

	function displayName(): string {
		const trimmedName = name?.trim();
		if (trimmedName) return trimmedName;
		const trimmedEmail = email?.trim();
		if (trimmedEmail) return trimmedEmail;
		return m.app_name();
	}
	const accountDisplayName = $derived(displayName());
	const accountInitial = $derived(accountDisplayName.charAt(0).toUpperCase());

	// Opens automatically on arrival at any settings route. A manual collapse
	// while already inside the section is respected until the next arrival, so
	// this never fights a caller who intentionally closes it mid-browse.
	let settingsMenuOpen = $state(false);
	$effect(() => {
		if (onSettingsRoute) settingsMenuOpen = true;
	});

	// In icon-collapsed desktop mode the submenu stays invisible even while
	// `settingsMenuOpen` is true (Sidebar.MenuSub hides itself under
	// group-data-[collapsible=icon]), so a click on the trigger would
	// otherwise do nothing a caller can see. Expanding the sidebar first
	// makes that same click reveal the submenu instead of feeling dead.
	// `mergeProps` composes this with the Collapsible trigger's own toggle
	// handler rather than replacing it.
	function expandSidebarForSettings(): void {
		if (!sidebar.isMobile && sidebar.state === 'collapsed') {
			sidebar.setOpen(true);
		}
	}
</script>

<Sidebar.Root variant="sidebar" collapsible="icon">
	<Sidebar.Header
		class="h-16 flex-row items-center gap-2 px-2 py-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
	>
		<div
			class="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"
		>
			<IconBolt class="size-4" />
		</div>
		<span class="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
			{m.app_name()}
		</span>
	</Sidebar.Header>
	<Sidebar.Content>
		<div class="p-2">
			<Button
				class="w-full group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0"
				href={localizeHref('/envelopes/new')}
			>
				<IconPlus data-icon="inline-start" />
				<span class="group-data-[collapsible=icon]:hidden">{m.new_agreement()}</span>
			</Button>
		</div>
		<Sidebar.Group>
			<Sidebar.GroupLabel>{m.nav_workspace()}</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each items as item (item.href)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={currentPath === item.href ||
									(item.href !== '/' && currentPath.startsWith(`${item.href}/`))}
								tooltipContent={item.title}
							>
								{#snippet child({ props })}
									<a href={localizeHref(item.href)} {...props}>
										<item.icon />
										<span>{item.title}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
					{#if visibleSettingsItems.length > 0}
						<Collapsible.Root bind:open={settingsMenuOpen} class="group/collapsible">
							{#snippet child({ props: collapsibleProps })}
								<Sidebar.MenuItem {...collapsibleProps}>
									<Collapsible.Trigger>
										{#snippet child({ props: triggerProps })}
											<Sidebar.MenuButton
												{...mergeProps(triggerProps, { onclick: expandSidebarForSettings })}
												isActive={onSettingsRoute}
												tooltipContent={m.nav_settings()}
											>
												<IconAdjustmentsHorizontal />
												<span>{m.nav_settings()}</span>
												<IconChevronRight
													class="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90"
												/>
											</Sidebar.MenuButton>
										{/snippet}
									</Collapsible.Trigger>
									<Collapsible.Content>
										<Sidebar.MenuSub>
											{#each visibleSettingsItems as item (item.href)}
												<Sidebar.MenuSubItem>
													<Sidebar.MenuSubButton
														href={localizeHref(item.href)}
														isActive={currentPath === item.href}
													>
														<item.icon />
														<span>{item.title}</span>
													</Sidebar.MenuSubButton>
												</Sidebar.MenuSubItem>
											{/each}
										</Sidebar.MenuSub>
									</Collapsible.Content>
								</Sidebar.MenuItem>
							{/snippet}
						</Collapsible.Root>
					{/if}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>
	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton {...props} size="lg" aria-label={accountDisplayName}>
								<Avatar.Root class="size-8">
									<Avatar.Fallback>{accountInitial}</Avatar.Fallback>
								</Avatar.Root>
								<span class="grid min-w-0 flex-1 text-left leading-tight">
									<span class="truncate text-sm font-semibold">{accountDisplayName}</span>
									<span class="truncate text-xs text-muted-foreground">{email}</span>
								</span>
								<IconSelector class="ml-auto" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content
						class="min-w-64"
						align="end"
						side={sidebar.isMobile ? 'bottom' : 'right'}
					>
						<DropdownMenu.Label class="font-normal">
							<p class="truncate text-sm font-semibold text-foreground">{accountDisplayName}</p>
							<p class="truncate text-xs text-muted-foreground">{email}</p>
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
						<DropdownMenu.Group>
							<form method="POST" action="/auth/logout">
								<DropdownMenu.Item variant="destructive" class="w-full">
									{#snippet child({ props })}
										<button {...props} type="submit">
											<IconLogout />
											{m.sign_out()}
										</button>
									{/snippet}
								</DropdownMenu.Item>
							</form>
						</DropdownMenu.Group>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
