<script lang="ts">
	import { page } from '$app/state';
	import {
		IconAdjustmentsHorizontal,
		IconBolt,
		IconSelector,
		IconFileText,
		IconLayoutDashboard,
		IconLogout,
		IconPlus,
		IconSettings
	} from '@tabler/icons-svelte';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { deLocalizeHref, localizeHref } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	let { email }: { email: string | null } = $props();

	const items = $derived([
		{ title: m.nav_dashboard(), href: '/', icon: IconLayoutDashboard },
		{ title: m.nav_agreements(), href: '/envelopes', icon: IconFileText },
		{ title: m.nav_settings(), href: '/settings', icon: IconAdjustmentsHorizontal }
	]);
	const currentPath = $derived(deLocalizeHref(page.url.pathname));
	const sidebar = Sidebar.useSidebar();
	const accountInitial = $derived((email ?? '?').trim().charAt(0).toUpperCase());
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
							<Sidebar.MenuButton {...props} size="lg" aria-label={email ?? m.nav_settings()}>
								<Avatar.Root class="size-8">
									<Avatar.Fallback>{accountInitial}</Avatar.Fallback>
								</Avatar.Root>
								<span class="min-w-0 flex-1 truncate text-left text-sm font-medium">
									{email}
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
							<p class="truncate text-xs text-muted-foreground">{email}</p>
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
						<DropdownMenu.Group>
							<DropdownMenu.Item>
								{#snippet child({ props })}
									<a {...props} href={localizeHref('/settings')}>
										<IconSettings />
										{m.nav_settings()}
									</a>
								{/snippet}
							</DropdownMenu.Item>
						</DropdownMenu.Group>
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
