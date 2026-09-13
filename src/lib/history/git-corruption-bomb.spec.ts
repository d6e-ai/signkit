import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { IsomorphicGitDraftRepository } from './isomorphic-git-repository';

describe('Git decompression bomb and corruption defenses', () => {
	it('rejects archive when payload exceeds MAX_DECODED_ARCHIVE_BYTES (16MB)', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const bombData = new Uint8Array(16 * 1024 * 1024 + 1024).fill(0x20);
		const archive = gzipSync(bombData, { level: 9, mtime: 0 });

		await expect(repository.read(archive, '0'.repeat(40))).rejects.toThrow(/decoded size limit/);
	});

	it('rejects decompression bomb with spoofed small ISIZE footer', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const bombData = new Uint8Array(16 * 1024 * 1024 + 1024).fill(0x20);
		const archive = gzipSync(bombData, { level: 9, mtime: 0 });

		// Gzip ends with 4-byte CRC32 followed by 4-byte ISIZE.
		// Spoof ISIZE to pretend it is only 500 bytes (0x01f4).
		const spoofed = Uint8Array.from(archive);
		const footerOffset = spoofed.byteLength - 4;
		spoofed[footerOffset] = 0xf4;
		spoofed[footerOffset + 1] = 0x01;
		spoofed[footerOffset + 2] = 0x00;
		spoofed[footerOffset + 3] = 0x00;

		// Streaming decompression must still detect the bomb exceeding decoded size limit
		// or reject due to CRC/integrity mismatch, never allowing unbounded allocation.
		await expect(repository.read(spoofed, '0'.repeat(40))).rejects.toThrow(
			/(decoded size limit|Invalid draft repository archive)/
		);
	});

	it('rejects corrupted or truncated gzip archive', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const corrupted = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff]);

		await expect(repository.read(corrupted, '0'.repeat(40))).rejects.toThrow(
			/(decoded size limit|Invalid draft repository archive)/
		);
	});

	it('rejects archive exceeding MAX_ARCHIVE_BYTES (12MB)', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const oversizedArchive = new Uint8Array(12 * 1024 * 1024 + 1);

		await expect(repository.read(oversizedArchive, '0'.repeat(40))).rejects.toThrow(
			/exceeds the size limit/
		);
	});

	it('rejects archive with invalid JSON or unsupported format payload', async () => {
		const repository = new IsomorphicGitDraftRepository();
		const badPayload = new TextEncoder().encode(
			JSON.stringify({ format: 'unknown-format', files: [] })
		);
		const archive = gzipSync(badPayload, { level: 9, mtime: 0 });

		await expect(repository.read(archive, '0'.repeat(40))).rejects.toThrow(
			/Unsupported draft repository archive/
		);
	});
});
