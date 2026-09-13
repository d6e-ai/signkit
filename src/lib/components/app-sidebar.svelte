<script lang="ts">
	import { page } from '$app/state';
	import {
		IconAddressBook,
		IconAdjustmentsHorizontal,
		IconBolt,
		IconChevronUp,
		IconFileText,
		IconInbox,
		IconLayoutDashboard,
		IconPlus,
		IconRobot,
		IconTemplate
	} from '@tabler/icons-svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { deLocalizeHref, localizeHref } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	const items = $derived([
		{ title: m.nav_dashboard(), href: '/', icon: IconLayoutDashboard },
		{ title: m.nav_inbox(), href: '/inbox', icon: IconInbox, badge: '3' },
		{ title: m.nav_agreements(), href: '/envelopes', icon: IconFileText },
		{ title: m.nav_templates(), href: '/templates', icon: IconTemplate },
		{ title: m.nav_contacts(), href: '/contacts', icon: IconAddressBook },
		{ title: m.nav_automation(), href: '/automation', icon: IconRobot },
		{ title: m.nav_settings(), href: '/settings', icon: IconAdjustmentsHorizontal }
	]);
	const currentPath = $derived(deLocalizeHref(page.url.pathname));
</script>

<Sidebar.Root variant="inset" collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Sidebar.MenuButton {...props} size="lg" class="data-[state=open]:bg-sidebar-accent">
								<div
									class="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground"
								>
									<IconBolt class="size-4" />
								</div>
								<div class="grid flex-1 text-left text-sm leading-tight">
									<span class="truncate font-semibold">{m.app_name()}</span>
									<span class="truncate text-xs text-muted-foreground">{m.workspace_name()}</span>
								</div>
								<IconChevronUp class="ml-auto" />
							</Sidebar.MenuButton>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content class="w-64" align="start" side="bottom">
						<DropdownMenu.Label>{m.nav_workspace()}</DropdownMenu.Label>
						<DropdownMenu.Item>{m.workspace_name()}</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
		<Button
			class="w-full group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-0"
			href={localizeHref('/envelopes/new')}
		>
			<IconPlus data-icon="inline-start" />
			<span class="group-data-[collapsible=icon]:hidden">{m.new_agreement()}</span>
		</Button>
	</Sidebar.Header>
	<Sidebar.Content>
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
							{#if item.badge}<Sidebar.MenuBadge>{item.badge}</Sidebar.MenuBadge>{/if}
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>
	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton tooltipContent="Open source workspace">
					<div
						class="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold"
					>
						YK
					</div>
					<div class="grid flex-1 text-left text-xs leading-tight">
						<span class="truncate font-medium">Yu Kimura</span>
						<span class="truncate text-muted-foreground">d6e-auth</span>
					</div>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
	<Sidebar.Rail />
</Sidebar.Root>
