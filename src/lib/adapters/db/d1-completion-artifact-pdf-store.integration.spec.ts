import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionArtifactPdfStore } from './d1-completion-artifact-pdf-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';

function database(): { sqlite: DatabaseSync; d1: D1Database } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { sqlite, d1: sqliteD1Database(sqlite) };
}

function seedCompletionArtifact(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ORGANIZATION_ID}', 'Agreement', 'completed', 1, 'commit-1',
			'commit-1', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01960000-0000-7000-8000-000000000001', '${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1,
			'envelope.completed', 'system', 'system', '{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}',
			'2026-09-11T00:02:00.000Z'
		);
		INSERT INTO completion_artifact (
			organization_id, envelope_id, schema_version, manifest_sha256,
			json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id,
			audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			'${ORGANIZATION_ID}', '${ENVELOPE_ID}', 1, '${'m'.repeat(64)}',
			'completion-artifacts/v1/org-1/env-1/sha256/${'j'.repeat(64)}.json.gz', '${'j'.repeat(64)}',
			'completion-artifacts/v1/org-1/env-1/sha256/${'d'.repeat(64)}.md.gz', '${'d'.repeat(64)}',
			'commit-1', 0, '01960000-0000-7000-8000-000000000001', 1, '${'e'.repeat(64)}',
			'2026-09-11T00:03:00.000Z', '01960000-0000-7000-8000-000000000003'
		);
	`);
}

describe('D1CompletionArtifactPdfStore integration', () => {
	it('publishes a PDF pointer for an existing completion artifact', async () => {
		const { sqlite, d1 } = database();
		try {
			seedCompletionArtifact(sqlite);
			const store = new D1CompletionArtifactPdfStore(d1);
			const command = {
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				pdfObjectKey: 'completion-artifacts/v1/org-1/env-1/sha256/pdf-hash.pdf',
				pdfSha256: 'f'.repeat(64),
				pdfManifestObjectKey:
					'completion-artifacts/v1/org-1/env-1/sha256/pdf-manifest-hash.json.gz',
				pdfManifestSha256: 'g'.repeat(64),
				publishedAt: '2026-09-11T00:04:00.000Z'
			};

			await expect(store.publishCompletionArtifactPdf(command)).resolves.toEqual({
				outcome: 'published'
			});
			await expect(store.readCompletionArtifactPdf(ORGANIZATION_ID, ENVELOPE_ID)).resolves.toEqual({
				pdfObjectKey: command.pdfObjectKey,
				pdfSha256: command.pdfSha256,
				pdfManifestObjectKey: command.pdfManifestObjectKey,
				pdfManifestSha256: command.pdfManifestSha256,
				publishedAt: command.publishedAt
			});
		} finally {
			sqlite.close();
		}
	});

	it('replaying the exact same digests is idempotent', async () => {
		const { sqlite, d1 } = database();
		try {
			seedCompletionArtifact(sqlite);
			const store = new D1CompletionArtifactPdfStore(d1);
			const command = {
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				pdfObjectKey: 'key-1',
				pdfSha256: 'f'.repeat(64),
				pdfManifestObjectKey: 'manifest-key-1',
				pdfManifestSha256: 'g'.repeat(64),
				publishedAt: '2026-09-11T00:04:00.000Z'
			};

			await expect(store.publishCompletionArtifactPdf(command)).resolves.toEqual({
				outcome: 'published'
			});
			await expect(store.publishCompletionArtifactPdf(command)).resolves.toEqual({
				outcome: 'already_published'
			});
		} finally {
			sqlite.close();
		}
	});

	it('fails closed on a digest mismatch against an already-published row', async () => {
		const { sqlite, d1 } = database();
		try {
			seedCompletionArtifact(sqlite);
			const store = new D1CompletionArtifactPdfStore(d1);
			const command = {
				organizationId: ORGANIZATION_ID,
				envelopeId: ENVELOPE_ID,
				pdfObjectKey: 'key-1',
				pdfSha256: 'f'.repeat(64),
				pdfManifestObjectKey: 'manifest-key-1',
				pdfManifestSha256: 'g'.repeat(64),
				publishedAt: '2026-09-11T00:04:00.000Z'
			};
			await store.publishCompletionArtifactPdf(command);

			await expect(
				store.publishCompletionArtifactPdf({ ...command, pdfSha256: 'h'.repeat(64) })
			).resolves.toEqual({ outcome: 'integrity_error' });
		} finally {
			sqlite.close();
		}
	});

	it('fails closed when the referenced completion artifact does not exist', async () => {
		const { sqlite, d1 } = database();
		try {
			const store = new D1CompletionArtifactPdfStore(d1);
			await expect(
				store.publishCompletionArtifactPdf({
					organizationId: ORGANIZATION_ID,
					envelopeId: ENVELOPE_ID,
					pdfObjectKey: 'key-1',
					pdfSha256: 'f'.repeat(64),
					pdfManifestObjectKey: 'manifest-key-1',
					pdfManifestSha256: 'g'.repeat(64),
					publishedAt: '2026-09-11T00:04:00.000Z'
				})
			).resolves.toEqual({ outcome: 'artifact_not_found' });
		} finally {
			sqlite.close();
		}
	});

	it('returns null for an envelope with no published PDF', async () => {
		const { sqlite, d1 } = database();
		try {
			seedCompletionArtifact(sqlite);
			const store = new D1CompletionArtifactPdfStore(d1);
			await expect(
				store.readCompletionArtifactPdf(ORGANIZATION_ID, ENVELOPE_ID)
			).resolves.toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
