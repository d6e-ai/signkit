import { describe, expect, it } from 'vitest';
import {
	PDF_SEAL_PROFILES,
	PdfSealProviderError,
	type PdfSealProfile,
	type PdfSealProvider
} from './pdf-seal-provider';

describe('PdfSealProvider port', () => {
	it('keeps the initial profile vocabulary closed', () => {
		const profiles: readonly PdfSealProfile[] = PDF_SEAL_PROFILES;
		expect(profiles).toEqual(['pades-b-b', 'pades-b-t']);
	});

	it('exposes only a stable safe error code as the Error message', () => {
		const error = new PdfSealProviderError('network_error', true, true);
		expect({
			name: error.name,
			message: error.message,
			code: error.code,
			retryable: error.retryable,
			ambiguous: error.ambiguous
		}).toEqual({
			name: 'PdfSealProviderError',
			message: 'network_error',
			code: 'network_error',
			retryable: true,
			ambiguous: true
		});
	});

	it('requires asynchronous submit, status, and result operations', () => {
		const provider: PdfSealProvider = {
			submit: async () => Promise.reject(new Error('unused')),
			getStatus: async () => Promise.reject(new Error('unused')),
			recoverAmbiguousSubmit: async () => Promise.reject(new Error('unused')),
			readResult: async () => Promise.reject(new Error('unused'))
		};
		expect(Object.keys(provider).sort()).toEqual([
			'getStatus',
			'readResult',
			'recoverAmbiguousSubmit',
			'submit'
		]);
	});
});
