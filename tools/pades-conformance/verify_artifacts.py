#!/usr/bin/env python3
"""Enforce the exact public PAdES artifact inventory before CI upload."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

PDF_NAMES = {
    "source.pdf",
    "pades-b-b.pdf",
    "pades-b-t.pdf",
    "tampered-b-b.pdf",
    "tampered-b-t.pdf",
    "invalid-ess-missing.pdf",
    "invalid-ess-mismatch.pdf",
    "invalid-tsa-eku-absent.pdf",
    "invalid-tsa-eku-noncritical.pdf",
    "invalid-tsa-eku-multipurpose.pdf",
}
TRUST_NAMES = {
    "trust/signer.pem",
    "trust/tsa.pem",
    "trust/tsa-eku-absent.pem",
    "trust/tsa-eku-noncritical.pem",
    "trust/tsa-eku-multipurpose.pem",
}
VALIDATION_NAMES = (
    "b-b",
    "b-t",
    "tampered-b-b",
    "tampered-b-t",
    "ess-missing",
    "ess-mismatch",
    "tsa-eku-absent",
    "tsa-eku-noncritical",
    "tsa-eku-multipurpose",
)
DSS_REPORT_SUFFIXES = ("simple", "detailed", "diagnostic", "etsi")
PYHANKO_REPORT_NAMES = {
    "reports/pyhanko-b-b.txt",
    "reports/pyhanko-b-b.stderr.txt",
    "reports/pyhanko-b-t.txt",
    "reports/pyhanko-b-t.stderr.txt",
    *(f"reports/pyhanko-{name}.txt" for name in VALIDATION_NAMES[2:]),
}
DSS_REPORT_NAMES = {
    f"reports/dss-{name}-{suffix}.xml"
    for name in VALIDATION_NAMES
    for suffix in DSS_REPORT_SUFFIXES
}
PROVENANCE_NAMES = {
    "reports/dss-version.txt",
    "reports/java-version.txt",
    "reports/maven-version.txt",
    "reports/maven-dependency-tree.txt",
}
EXPECTED_FILES = {
    *PDF_NAMES,
    *TRUST_NAMES,
    *PYHANKO_REPORT_NAMES,
    *DSS_REPORT_NAMES,
    *PROVENANCE_NAMES,
    "manifest.json",
    "SHA256SUMS",
}
PRIVATE_KEY_SUFFIXES = {".key", ".p12", ".pfx", ".pkcs12"}
PRIVATE_KEY_PATTERN = re.compile(rb"BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY")


def verify_artifacts(output_dir: Path) -> None:
    if not output_dir.is_dir():
        raise AssertionError("PAdES output directory was not created")
    symlinks = sorted(
        str(path.relative_to(output_dir))
        for path in output_dir.rglob("*")
        if path.is_symlink()
    )
    if symlinks:
        raise AssertionError(f"artifact inventory contains symlinks: {symlinks}")
    actual_files = {
        str(path.relative_to(output_dir))
        for path in output_dir.rglob("*")
        if path.is_file()
    }
    missing = sorted(EXPECTED_FILES - actual_files)
    unexpected = sorted(actual_files - EXPECTED_FILES)
    if missing or unexpected:
        raise AssertionError(
            f"artifact inventory mismatch; missing={missing}; unexpected={unexpected}"
        )
    forbidden_suffixes = sorted(
        relative
        for relative in actual_files
        if Path(relative).suffix.lower() in PRIVATE_KEY_SUFFIXES
    )
    if forbidden_suffixes:
        raise AssertionError(
            f"forbidden private-key file extension: {forbidden_suffixes}"
        )
    private_key_content = sorted(
        relative
        for relative in actual_files
        if PRIVATE_KEY_PATTERN.search((output_dir / relative).read_bytes())
    )
    if private_key_content:
        raise AssertionError(
            f"private-key material in public artifact inventory: {private_key_content}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    verify_artifacts(args.out.resolve())


if __name__ == "__main__":
    main()
