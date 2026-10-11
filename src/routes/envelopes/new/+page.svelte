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
	let titleValidationAttempted = $state(false);
	const titleInvalid = $derived(titleValidationAttempted && title.trim().length === 0);

	async function handleSubmit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (pending) return;
		titleValidationAttempted = true;
		const trimmed = title.trim();
		if (trimmed.length === 0) {
			document.getElementById('envelope-title')?.focus();
			return;
		}
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
		<form novalidate onsubmit={handleSubmit}>
			<Card.Content>
				<Field.FieldGroup>
					<Field.Field data-invalid={titleInvalid || undefined}>
						<Field.FieldLabel for="envelope-title">{m.envelope_title_label()}</Field.FieldLabel>
						<Input
							id="envelope-title"
							bind:value={title}
							placeholder={m.envelope_title_placeholder()}
							maxlength={200}
							disabled={pending}
							aria-invalid={titleInvalid || undefined}
							aria-describedby={titleInvalid ? 'envelope-title-error' : undefined}
							required
						/>
						{#if titleInvalid}
							<Field.FieldError id="envelope-title-error"
								>{m.envelope_title_required()}</Field.FieldError
							>
						{/if}
					</Field.Field>
				</Field.FieldGroup>
				{#if error}
					<p class="mt-4 text-sm text-destructive" role="alert">{error}</p>
				{/if}
			</Card.Content>
			<Card.Footer class="justify-end gap-2">
				<Button variant="outline" href={localizeHref('/envelopes')} disabled={pending}>
					{m.common_cancel()}
				</Button>
				<Button type="submit" disabled={pending}>
					{#if pending}<Spinner data-icon="inline-start" />{/if}
					{m.envelope_new_create()}
				</Button>
			</Card.Footer>
		</form>
	</Card.Root>
</div>
