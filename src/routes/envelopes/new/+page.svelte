<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Spinner } from '$lib/components/ui/spinner';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import { createEnvelopesClient, EnvelopesApiError } from '$lib/client/envelopes';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';

	const client = createEnvelopesClient();

	let title = $state('');
	let pending = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const trimmed = title.trim();
		if (trimmed.length === 0 || pending) return;
		pending = true;
		error = null;
		try {
			const { envelope } = await client.create(trimmed);
			await goto(localizeHref(`/envelopes/${envelope.id}`));
		} catch (cause) {
			error = cause instanceof EnvelopesApiError ? cause.detail : m.envelope_new_unavailable();
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head>
	<title>{m.envelope_new_title()} — {m.app_name()}</title>
</svelte:head>

<div class="w-full">
	<Card.Root>
		<Card.Header>
			<div
				class="mb-2 flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary"
			>
				<IconFileText />
			</div>
			<Card.Title>{m.envelope_new_title()}</Card.Title>
			<Card.Description>{m.envelope_new_description()}</Card.Description>
		</Card.Header>
		<form onsubmit={handleSubmit}>
			<Card.Content>
				<Field.FieldGroup>
					<Field.Field data-invalid={error !== null || undefined}>
						<Field.FieldLabel for="envelope-title">{m.envelope_title_label()}</Field.FieldLabel>
						<Input
							id="envelope-title"
							bind:value={title}
							placeholder={m.envelope_title_placeholder()}
							maxlength={200}
							disabled={pending}
							aria-invalid={error !== null || undefined}
							required
						/>
						{#if error}
							<Field.FieldDescription class="text-destructive">{error}</Field.FieldDescription>
						{/if}
					</Field.Field>
				</Field.FieldGroup>
			</Card.Content>
			<Card.Footer class="justify-end gap-2">
				<Button variant="outline" href={localizeHref('/envelopes')} disabled={pending}>
					{m.common_cancel()}
				</Button>
				<Button type="submit" disabled={pending || title.trim().length === 0}>
					{#if pending}<Spinner data-icon="inline-start" />{/if}
					{m.envelope_new_create()}
				</Button>
			</Card.Footer>
		</form>
	</Card.Root>
</div>
