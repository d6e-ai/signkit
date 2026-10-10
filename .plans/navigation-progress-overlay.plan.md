# Keep breadcrumbs visible and show a root navigation overlay

Issue: https://github.com/d6e-ai/signkit/issues/119

Match d6e-auth. SignKit has no local login/register UI; this is navigation chrome only.

## Requirements

1. Client navigations must not look frozen. Keep AppBreadcrumbs visible.
2. Show a translucent overlay below the 64px header with a spinner and nav_loading().
3. Cover both the authenticated shell and the bare header (signed-out, setup, recipient) because those headers are also h-16.

## Implementation

- Add src/lib/components/navigation-progress.svelte
- Mount it from src/routes/+layout.svelte
- Stop swapping breadcrumbs for a spinner
- Set aria-busy on Sidebar.Inset
- Update src/routes/layout-shell.spec.ts
