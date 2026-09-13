<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as m from '$lib/paraglide/messages';

	const CANVAS_WIDTH = 600;
	const CANVAS_HEIGHT = 200;
	const STROKE_COLOR = '#111827';
	const STROKE_WIDTH = 2.5;

	let {
		envelopeId,
		recipientId,
		value = $bindable(''),
		disabled = false,
		id
	}: {
		envelopeId: string;
		recipientId: string;
		value?: string;
		disabled?: boolean;
		id: string;
	} = $props();

	let mode = $state<'draw' | 'type'>('draw');
	let canvasElement = $state<HTMLCanvasElement | null>(null);
	let hasDrawing = $state(false);
	let drawing = $state(false);
	let uploadPending = $state(false);
	let uploadError = $state<string | null>(null);
	let typedValue = $state(value.startsWith('sig:sha256:') ? '' : value);

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
		const ctx = context();
		if (ctx) ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
		hasDrawing = false;
		uploadError = null;
		value = '';
	}

	async function uploadDrawing(): Promise<void> {
		if (!canvasElement) return;
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
			value = data.assetRef;
		} catch {
			uploadError = m.signature_canvas_upload_failed();
		} finally {
			uploadPending = false;
		}
	}

	function handleTypedInput(event: Event & { currentTarget: HTMLInputElement }): void {
		typedValue = event.currentTarget.value;
		value = typedValue;
	}

	function handleModeChange(next: string): void {
		mode = next === 'type' ? 'type' : 'draw';
		if (mode === 'type') value = typedValue;
		else if (!hasDrawing) value = '';
	}
</script>

<div class="flex flex-col gap-2">
	<Tabs.Root value={mode} onValueChange={handleModeChange}>
		<Tabs.List>
			<Tabs.Trigger value="draw">{m.signature_canvas_tab_draw()}</Tabs.Trigger>
			<Tabs.Trigger value="type">{m.signature_canvas_tab_type()}</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="draw" class="flex flex-col gap-2">
			<p id={`${id}-instructions`} class="text-xs text-muted-foreground">
				{m.signature_canvas_instructions()}
			</p>
			<canvas
				bind:this={canvasElement}
				width={CANVAS_WIDTH}
				height={CANVAS_HEIGHT}
				tabindex="0"
				aria-label={m.signature_canvas_label()}
				aria-describedby={`${id}-instructions`}
				class="max-w-full touch-none rounded-2xl border bg-background"
				style="aspect-ratio: {CANVAS_WIDTH} / {CANVAS_HEIGHT}; width: 100%;"
				onpointerdown={handlePointerDown}
				onpointermove={handlePointerMove}
				onpointerup={handlePointerUp}
				onpointercancel={handlePointerUp}
			></canvas>
			<div class="flex items-center gap-3">
				<Button type="button" variant="outline" size="sm" onclick={clearCanvas} {disabled}>
					{m.signature_canvas_clear()}
				</Button>
				{#if uploadPending}
					<span class="flex items-center gap-1 text-xs text-muted-foreground">
						<Spinner data-icon="inline-start" />{m.signature_canvas_uploading()}
					</span>
				{:else if uploadError}
					<span class="text-xs font-medium text-destructive">{uploadError}</span>
				{:else if !hasDrawing}
					<span class="text-xs text-muted-foreground">{m.signature_canvas_empty()}</span>
				{/if}
			</div>
		</Tabs.Content>
		<Tabs.Content value="type">
			<label for={`${id}-typed`} class="mb-1.5 block text-xs text-muted-foreground">
				{m.signature_canvas_typed_label()}
			</label>
			<Input
				id={`${id}-typed`}
				value={typedValue}
				oninput={handleTypedInput}
				placeholder={m.signature_canvas_typed_placeholder()}
				maxlength={200}
				{disabled}
			/>
		</Tabs.Content>
	</Tabs.Root>
</div>
