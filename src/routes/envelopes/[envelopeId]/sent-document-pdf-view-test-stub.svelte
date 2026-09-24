<script lang="ts">
	/**
	 * Stands in for PdfDocumentView in the sent-documents Documents-tab tests:
	 * it surfaces the props the real component would use to fetch and label
	 * the PDF, without booting pdf.js. The component's own loading/error/canvas
	 * behavior has a dedicated browser suite (pdf-document-view.browser.spec.ts);
	 * these tests only need to confirm the Documents tab wires the right
	 * document to the right endpoint.
	 */
	let {
		src,
		label,
		expectedPageCount
	}: {
		src: string;
		label: string;
		expectedPageCount: number;
	} = $props();
</script>

<!-- The label is asserted through data-label rather than visible text, so it
     never collides with the surrounding Card.Title rendering the same title. -->
<div
	data-testid="sent-document-pdf-stub"
	data-src={src}
	data-label={label}
	data-page-count={expectedPageCount}
></div>
