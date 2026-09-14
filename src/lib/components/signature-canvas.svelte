<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as m from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import {
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
		label = '',
		triggerClass = '',
		id
	}: {
		envelopeId: string;
		recipientId: string;
		recipientName?: string;
		value?: string;
		disabled?: boolean;
		invalid?: boolean;
		/** Accessible name for the trigger when it is an overlay box on a page. */
		label?: string;
		triggerClass?: string;
		id: string;
	} = $props();

	let open = $state(false);
	let mode = $state<SignatureMode>('type');
	let typedValue = $state('');
	/**
	 * An asset the field already committed, carried into the dialog so an
	 * unchanged drawn signature can be re-confirmed without a second upload.
	 * Any new stroke, a clear, or a mode switch discards it: reusing it after
	 * the canvas changed would commit a picture the signer no longer sees.
	 */
	let committedAssetRef = $state('');
	let canvasElement = $state<HTMLCanvasElement | null>(null);
	let typedInput = $state<HTMLInputElement | null>(null);
	let hasDrawing = $state(false);
	let drawing = $state(false);
	let uploadPending = $state(false);
	let uploadError = $state<string | null>(null);
	/**
	 * Incremented by every action that invalidates an in-flight upload. A
	 * response that arrives with a stale token is discarded rather than
	 * committed, so a slow network cannot resurrect a drawing the signer
	 * cleared, replaced, or cancelled.
	 */
	let uploadToken = $state(0);

	const canConfirm = $derived(
		!uploadPending &&
			(mode === 'type'
				? typedValue.trim().length > 0
				: hasDrawing || isSignatureAssetRef(committedAssetRef))
	);

	function triggerText(): string {
		if (isSignatureAssetRef(value)) return m.signature_trigger_drawn();
		if (value.trim().length > 0) return value;
		return m.signature_trigger_empty();
	}

	function applyDraft(draft: SignatureDraft): void {
		mode = draft.mode;
		typedValue = draft.typedValue;
		committedAssetRef = draft.assetRef;
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
		// Closing for any reason -- Cancel, Escape, the overlay, the close
		// button -- abandons the draft and any upload it started. Only the
		// confirm button ever writes to `value`.
		if (!next) uploadToken += 1;
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

	/** Drawing is local. Nothing leaves the browser until the signer confirms. */
	function handlePointerDown(event: PointerEvent): void {
		if (disabled) return;
		const ctx = context();
		if (!ctx) return;
		(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
		discardDraftAsset();
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

	function handlePointerUp(): void {
		drawing = false;
	}

	function discardDraftAsset(): void {
		uploadToken += 1;
		uploadPending = false;
		uploadError = null;
		committedAssetRef = '';
	}

	function clearCanvas(): void {
		discardDraftAsset();
		const ctx = context();
		if (ctx) ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
		hasDrawing = false;
		drawing = false;
	}

	/**
	 * Uploads the current canvas exactly once and returns the asset reference,
	 * or null when the attempt failed or was invalidated while in flight.
	 */
	async function uploadDrawing(token: number): Promise<string | null> {
		if (!canvasElement) return null;
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
			if (token !== uploadToken || !open) return null;
			if (typeof data.assetRef !== 'string' || !isSignatureAssetRef(data.assetRef)) {
				throw new Error('upload returned an invalid asset reference');
			}
			return data.assetRef;
		} catch {
			if (token !== uploadToken || !open) return null;
			uploadError = m.signature_canvas_upload_failed();
			return null;
		}
	}

	function handleModeChange(next: string): void {
		const requested: SignatureMode = next === 'draw' ? 'draw' : 'type';
		if (requested === mode) return;
		// Switching modes abandons whatever the other mode was holding, in-flight
		// upload included, so a confirm can only ever commit what is on screen.
		discardDraftAsset();
		hasDrawing = false;
		mode = requested;
	}

	async function confirmSignature(): Promise<void> {
		if (uploadPending || disabled) return;
		if (mode === 'type') {
			const trimmed: string = typedValue.trim();
			if (trimmed.length === 0) return;
			value = trimmed;
			open = false;
			return;
		}

		if (hasDrawing) {
			const token: number = uploadToken;
			uploadPending = true;
			uploadError = null;
			const assetRef: string | null = await uploadDrawing(token);
			if (token === uploadToken) uploadPending = false;
			// A stale token means the signer cleared, redrew, switched modes, or
			// closed the dialog while this was in flight; committing now would
			// attach an asset that no longer matches the canvas.
			if (assetRef === null || token !== uploadToken || !open) return;
			value = assetRef;
			open = false;
			return;
		}

		if (isSignatureAssetRef(committedAssetRef)) {
			value = committedAssetRef;
			open = false;
		}
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{id}
				variant="outline"
				class={cn('min-h-[44px] w-full justify-start', triggerClass)}
				{disabled}
				aria-label={label.length > 0 ? `${label}: ${triggerText()}` : undefined}
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
								{:else if hasDrawing}
									<span class="text-sm text-muted-foreground">{m.signature_canvas_drawn()}</span>
								{:else if isSignatureAssetRef(committedAssetRef)}
									<span class="text-sm text-muted-foreground">{m.signature_canvas_ready()}</span>
								{:else}
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
			<Button
				class="min-h-[44px]"
				disabled={disabled || !canConfirm}
				onclick={() => void confirmSignature()}
			>
				{#if uploadPending}
					<Spinner data-icon="inline-start" />
				{/if}
				{uploadPending ? m.signature_canvas_uploading() : m.signature_dialog_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
