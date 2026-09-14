<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages';
	import {
		committedFromDraft,
		draftFromCommitted,
		isSignatureAssetRef,
		type SignatureDraft,
		type SignatureMode
	} from './signature-draft';

	const CANVAS_WIDTH = 600;
	const CANVAS_HEIGHT = 200;
	const STROKE_COLOR = '#111827';
	const STROKE_WIDTH = 2.5;

	let {
		envelopeId,
		recipientId,
		recipientName = '',
		value = $bindable(''),
		disabled = false,
		invalid = false,
		id
	}: {
		envelopeId: string;
		recipientId: string;
		recipientName?: string;
		value?: string;
		disabled?: boolean;
		invalid?: boolean;
		id: string;
	} = $props();

	let open = $state(false);
	let mode = $state<SignatureMode>('type');
	let typedValue = $state('');
	let draftAssetRef = $state('');
	let canvasElement = $state<HTMLCanvasElement | null>(null);
	let typedInput = $state<HTMLInputElement | null>(null);
	let hasDrawing = $state(false);
	let drawing = $state(false);
	let uploadPending = $state(false);
	let uploadError = $state<string | null>(null);
	let uploadToken = $state(0);

	const canConfirm = $derived(
		!uploadPending && committedFromDraft({ mode, typedValue, assetRef: draftAssetRef }) !== null
	);

	function triggerText(): string {
		if (isSignatureAssetRef(value)) return m.signature_trigger_drawn();
		if (value.trim().length > 0) return value;
		return m.signature_trigger_empty();
	}

	function applyDraft(draft: SignatureDraft): void {
		mode = draft.mode;
		typedValue = draft.typedValue;
		draftAssetRef = draft.assetRef;
		hasDrawing = false;
		drawing = false;
		uploadPending = false;
		uploadError = null;
		uploadToken += 1;
		const ctx = canvasElement?.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
	}

	function handleOpenChange(next: boolean): void {
		open = next;
		if (next) applyDraft(draftFromCommitted(value, recipientName));
	}

	async function handleOpenAutoFocus(event: Event): Promise<void> {
		if (mode !== 'type') return;
		event.preventDefault();
		await tick();
		typedInput?.focus();
	}

	function context(): CanvasRenderingContext2D | null {
		return canvasElement?.getContext('2d') ?? null;
	}

	function pointFromEvent(event: PointerEvent): { x: number; y: number } {
		const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		const scaleX = CANVAS_WIDTH / rect.width;
		const scaleY = CANVAS_HEIGHT / rect.height;
		return {
			x: (event.clientX - rect.left) * scaleX,
			y: (event.clientY - rect.top) * scaleY
		};
	}

	function handlePointerDown(event: PointerEvent): void {
		if (disabled) return;
		const ctx = context();
		if (!ctx) return;
		(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
		drawing = true;
		const point = pointFromEvent(event);
		ctx.strokeStyle = STROKE_COLOR;
		ctx.lineWidth = STROKE_WIDTH;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(point.x, point.y);
	}

	function handlePointerMove(event: PointerEvent): void {
		if (!drawing || disabled) return;
		const ctx = context();
		if (!ctx) return;
		const point = pointFromEvent(event);
		ctx.lineTo(point.x, point.y);
		ctx.stroke();
		hasDrawing = true;
	}

	async function handlePointerUp(): Promise<void> {
		if (!drawing) return;
		drawing = false;
		if (hasDrawing) await uploadDrawing();
	}

	function clearCanvas(): void {
		uploadToken += 1;
		const ctx = context();
		if (ctx) ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
		hasDrawing = false;
		drawing = false;
		uploadPending = false;
		uploadError = null;
		draftAssetRef = '';
	}

	async function uploadDrawing(): Promise<void> {
		if (!canvasElement) return;
		const token = ++uploadToken;
		uploadPending = true;
		uploadError = null;
		try {
			const blob: Blob | null = await new Promise((resolve) =>
				canvasElement?.toBlob(resolve, 'image/png')
			);
			if (!blob) throw new Error('canvas produced no image data');
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const response = await fetch(
				`/api/v1/signing/signature-assets?envelopeId=${encodeURIComponent(envelopeId)}&recipientId=${encodeURIComponent(recipientId)}`,
				{
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'image/png' },
					body: bytes
				}
			);
			if (!response.ok) throw new Error(`upload failed with status ${response.status}`);
			const data = (await response.json()) as { assetRef: string };
			if (token !== uploadToken || !open) return;
			if (typeof data.assetRef !== 'string' || !isSignatureAssetRef(data.assetRef)) {
				throw new Error('upload returned an invalid asset reference');
			}
			draftAssetRef = data.assetRef;
		} catch {
			if (token !== uploadToken || !open) return;
			uploadError = m.signature_canvas_upload_failed();
			draftAssetRef = '';
		} finally {
			if (token === uploadToken) uploadPending = false;
		}
	}

	function handleModeChange(next: string): void {
		mode = next === 'draw' ? 'draw' : 'type';
	}

	function confirmSignature(): void {
		const next = committedFromDraft({ mode, typedValue, assetRef: draftAssetRef });
		if (next === null || uploadPending) return;
		value = next;
		open = false;
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{id}
				variant="outline"
				class="min-h-[44px] w-full justify-start"
				{disabled}
				aria-invalid={invalid || undefined}
			>
				<span class="truncate">{triggerText()}</span>
			</Button>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content
		class="sm:max-w-lg"
		closeLabel={m.signature_dialog_close()}
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<Dialog.Header>
			<Dialog.Title>{m.signature_dialog_title()}</Dialog.Title>
			<Dialog.Description>{m.signature_dialog_description()}</Dialog.Description>
		</Dialog.Header>
		<Field.FieldGroup>
			<Field.Field>
				<Tabs.Root value={mode} onValueChange={handleModeChange}>
					<Tabs.List>
						<Tabs.Trigger value="type">{m.signature_canvas_tab_type()}</Tabs.Trigger>
						<Tabs.Trigger value="draw">{m.signature_canvas_tab_draw()}</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="type">
						<Field.Field>
							<Field.FieldLabel for={`${id}-typed`}>
								{m.signature_canvas_typed_label()}
							</Field.FieldLabel>
							<Input
								id={`${id}-typed`}
								bind:ref={typedInput}
								bind:value={typedValue}
								placeholder={m.signature_canvas_typed_placeholder()}
								maxlength={200}
								{disabled}
							/>
						</Field.Field>
					</Tabs.Content>
					<Tabs.Content value="draw">
						<Field.Field data-invalid={uploadError ? true : undefined}>
							<p id={`${id}-instructions`} class="text-sm text-muted-foreground">
								{m.signature_canvas_instructions()}
							</p>
							<canvas
								bind:this={canvasElement}
								width={CANVAS_WIDTH}
								height={CANVAS_HEIGHT}
								tabindex="0"
								aria-label={m.signature_canvas_label()}
								aria-describedby={`${id}-instructions`}
								aria-invalid={uploadError ? true : undefined}
								class="max-w-full touch-none rounded-2xl border bg-background"
								style="aspect-ratio: {CANVAS_WIDTH} / {CANVAS_HEIGHT}; width: 100%;"
								onpointerdown={handlePointerDown}
								onpointermove={handlePointerMove}
								onpointerup={handlePointerUp}
								onpointercancel={handlePointerUp}
							></canvas>
							<div class="flex flex-wrap items-center gap-3">
								<Button type="button" variant="outline" size="sm" onclick={clearCanvas} {disabled}>
									{m.signature_canvas_clear()}
								</Button>
								{#if uploadPending}
									<span class="flex items-center gap-1 text-sm text-muted-foreground">
										<Spinner data-icon="inline-start" />{m.signature_canvas_uploading()}
									</span>
								{:else if uploadError}
									<Field.FieldError>{uploadError}</Field.FieldError>
								{:else if draftAssetRef}
									<span class="text-sm text-muted-foreground">{m.signature_canvas_ready()}</span>
								{:else if !hasDrawing}
									<span class="text-sm text-muted-foreground">{m.signature_canvas_empty()}</span>
								{/if}
							</div>
						</Field.Field>
					</Tabs.Content>
				</Tabs.Root>
			</Field.Field>
		</Field.FieldGroup>
		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}
					<Button {...props} variant="outline" class="min-h-[44px]" {disabled}>
						{m.signature_dialog_cancel()}
					</Button>
				{/snippet}
			</Dialog.Close>
			<Button class="min-h-[44px]" disabled={disabled || !canConfirm} onclick={confirmSignature}>
				{#if uploadPending}
					<Spinner data-icon="inline-start" />
				{/if}
				{uploadPending ? m.signature_canvas_uploading() : m.signature_dialog_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
