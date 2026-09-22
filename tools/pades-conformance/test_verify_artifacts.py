from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from verify_artifacts import EXPECTED_FILES, verify_artifacts


class VerifyArtifactsTest(unittest.TestCase):
    def populate(self, root: Path) -> None:
        for relative in EXPECTED_FILES:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"public conformance evidence\n")

    def test_accepts_only_complete_public_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            verify_artifacts(root)

    def test_missing_path_cannot_mask_private_key_material(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            (root / "manifest.json").unlink()
            (root / "trust/signer.pem").write_bytes(
                b"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n"
            )
            with self.assertRaisesRegex(AssertionError, "inventory mismatch"):
                verify_artifacts(root)

    def test_rejects_private_key_material_in_complete_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            (root / "reports/pyhanko-b-t.txt").write_bytes(
                b"-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n"
            )
            with self.assertRaisesRegex(AssertionError, "private-key material"):
                verify_artifacts(root)

    def test_rejects_unexpected_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.populate(root)
            (root / "reports/unexpected.txt").write_text("unexpected\n")
            with self.assertRaisesRegex(AssertionError, "unexpected"):
                verify_artifacts(root)


if __name__ == "__main__":
    unittest.main()
