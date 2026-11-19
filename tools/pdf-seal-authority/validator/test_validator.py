"""Focused tests using ephemeral fixture-only keys (TEST ONLY; nothing is persisted)."""

from __future__ import annotations

import base64
import hashlib
import http.client
import io
import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pyhanko.keys import load_cert_from_pemder, load_private_key_from_pemder
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import signers
from pyhanko.sign.fields import SigSeedSubFilter
from pyhanko.sign.timestamps import DummyTimeStamper

from config import Config, ConfigurationError, load_config
from engine import Reference, _revision_changes_allowed, evaluate
from server import MEDIA_TYPE, ValidatorServer

TOKEN = "t" * 40
NOT_BEFORE = datetime(2025, 1, 1, tzinfo=UTC)
NOT_AFTER = datetime(2040, 1, 1, tzinfo=UTC)


def _name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SignKit validator TEST ONLY"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )


def _ca(label: str) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = _name(f"{label} - NOT FOR PRODUCTION")
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def _leaf(ca_key: rsa.RSAPrivateKey, ca: x509.Certificate) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name("Seal - NOT FOR PRODUCTION"))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(2)
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(True, True, False, False, False, False, False, False, False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return key, cert


def _source_pdf() -> bytes:
    stream = b"BT /F1 18 Tf 72 720 Td (validator fixture) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream",
    ]
    pdf = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        pdf += b"%010d 00000 n \n" % offset
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(pdf)


class Fixture:
    def __init__(self, tmp_path: Path) -> None:
        ca_key, self.ca = _ca("Validator CI Root")
        self.signer_key, self.signer = _leaf(ca_key, self.ca)
        self.rogue_key, self.rogue_ca = _ca("Rogue Root")
        self.rogue_signer_key, self.rogue_signer = _leaf(self.rogue_key, self.rogue_ca)
        self.dir = tmp_path
        self.source = _source_pdf()

    def _signer(self, key: rsa.RSAPrivateKey, cert: x509.Certificate, ca: x509.Certificate) -> signers.SimpleSigner:
        key_path, cert_path, ca_path = (self.dir / name for name in ("k.pem", "c.pem", "ca.pem"))
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
        signer = signers.SimpleSigner.load(
            key_file=str(key_path),
            cert_file=str(cert_path),
            ca_chain_files=(str(ca_path),),
            key_passphrase=None,
        )
        assert signer is not None
        return signer

    def sign(self, *, rogue: bool = False, timestamp: bool = False, certify: bool = False) -> bytes:
        import io

        signer = (
            self._signer(self.rogue_signer_key, self.rogue_signer, self.rogue_ca)
            if rogue
            else self._signer(self.signer_key, self.signer, self.ca)
        )
        timestamper = None
        if timestamp:
            timestamper = DummyTimeStamper(
                tsa_cert=load_cert_from_pemder(str(self.dir / "c.pem")),
                tsa_key=load_private_key_from_pemder(str(self.dir / "k.pem"), passphrase=None),
                certs_to_embed=None,
                fixed_dt=datetime(2026, 1, 1, tzinfo=UTC),
                include_nonce=True,
            )
        metadata = signers.PdfSignatureMetadata(
            field_name="InstanceSeal",
            md_algorithm="sha256",
            subfilter=SigSeedSubFilter.PADES,
            certify=certify,
        )
        output = io.BytesIO()
        writer = IncrementalPdfFileWriter(io.BytesIO(self.source))
        signers.sign_pdf(
            writer, signature_meta=metadata, signer=signer, timestamper=timestamper, output=output
        )
        return output.getvalue()

    def config(self, **overrides: str) -> Config:
        env = {
            "VALIDATOR_TOKEN": TOKEN,
            "SEAL_CA_DER": base64.b64encode(self.ca.public_bytes(serialization.Encoding.DER)).decode(),
            "SEAL_CERTIFICATE_SHA256": self.signer.fingerprint(hashes.SHA256()).hex(),
            "SEAL_POLICY_ID": "seal-policy-1",
            "VALIDATION_POLICY_ID": "validation-policy-1",
        }
        env.update(overrides)
        return load_config(env)

    def reference(self, **overrides: str) -> Reference:
        values = {
            "seal_policy_id": "seal-policy-1",
            "validation_policy_id": "validation-policy-1",
            "signer_certificate_sha256": self.signer.fingerprint(hashes.SHA256()).hex(),
        }
        values.update(overrides)
        return Reference(**values)


@pytest.fixture(scope="module")
def fx(tmp_path_factory: pytest.TempPathFactory) -> Fixture:
    return Fixture(tmp_path_factory.mktemp("validator"))


@pytest.fixture(scope="module")
def sealed(fx: Fixture) -> bytes:
    return fx.sign()


def test_valid_b_b_is_accepted_with_every_check_computed(fx: Fixture, sealed: bytes) -> None:
    outcome = evaluate(fx.config(), fx.reference(), fx.source, sealed)
    assert outcome.failures == set()
    assert outcome.valid and all(outcome.checks.values())


def test_incremental_validation_requires_the_original_catalogue(fx: Fixture) -> None:
    source = PdfFileReader(io.BytesIO(fx.source))
    other_root = SimpleNamespace(idnum=source.root_ref.idnum + 1, generation=0)
    assert not _revision_changes_allowed(source, SimpleNamespace(root_ref=other_root), 1, None)


def test_modified_source_prefix_is_rejected(fx: Fixture, sealed: bytes) -> None:
    tampered = bytearray(sealed)
    tampered[fx.source.find(b"validator fixture")] ^= 0x01
    outcome = evaluate(fx.config(), fx.reference(), fx.source, bytes(tampered))
    assert not outcome.valid and "source_prefix_mismatch" in outcome.failures


def test_bytes_after_seal_are_rejected(fx: Fixture, sealed: bytes) -> None:
    outcome = evaluate(fx.config(), fx.reference(), fx.source, sealed + b"%junk\n")
    assert not outcome.valid
    assert {"byte_range_invalid", "post_seal_changes_detected"} & outcome.failures


def test_signed_content_change_invalidates_cms(fx: Fixture, sealed: bytes) -> None:
    offset = len(fx.source) + sealed[len(fx.source) :].find(b"/Type /Sig")
    tampered = bytearray(sealed)
    tampered[offset + 1] ^= 0x01  # inside the signed revision, source prefix untouched
    outcome = evaluate(fx.config(), fx.reference(), fx.source, bytes(tampered))
    assert not outcome.valid


def test_untrusted_ca_is_rejected(fx: Fixture) -> None:
    rogue = fx.sign(rogue=True)
    reference = fx.reference(
        signer_certificate_sha256=fx.rogue_signer.fingerprint(hashes.SHA256()).hex()
    )
    config = fx.config(SEAL_CERTIFICATE_SHA256=reference.signer_certificate_sha256)
    outcome = evaluate(config, reference, fx.source, rogue)
    assert not outcome.valid and "certificate_path_invalid" in outcome.failures


def test_unpinned_signer_certificate_is_rejected(fx: Fixture, sealed: bytes) -> None:
    outcome = evaluate(fx.config(SEAL_CERTIFICATE_SHA256="0" * 64), fx.reference(), fx.source, sealed)
    assert "signer_certificate_mismatch" in outcome.failures


def test_policy_mismatch_is_rejected(fx: Fixture, sealed: bytes) -> None:
    outcome = evaluate(
        fx.config(), fx.reference(seal_policy_id="other-policy"), fx.source, sealed
    )
    assert "seal_policy_rejected" in outcome.failures


def test_timestamped_b_t_profile_is_rejected(fx: Fixture) -> None:
    outcome = evaluate(fx.config(), fx.reference(), fx.source, fx.sign(timestamp=True))
    assert not outcome.valid and "cms_profile_invalid" in outcome.failures


def test_docmdp_certification_is_rejected(fx: Fixture) -> None:
    outcome = evaluate(fx.config(), fx.reference(), fx.source, fx.sign(certify=True))
    assert not outcome.valid and "doc_mdp_forbidden" in outcome.failures


def test_unchanged_source_is_not_a_seal(fx: Fixture) -> None:
    outcome = evaluate(fx.config(), fx.reference(), fx.source, fx.source + b"\n")
    assert not outcome.valid


def test_configuration_fails_closed(fx: Fixture) -> None:
    with pytest.raises(ConfigurationError):
        fx.config(VALIDATOR_TOKEN="short")
    with pytest.raises(ConfigurationError):
        fx.config(SEAL_CERTIFICATE_SHA256="A" * 64)
    with pytest.raises(ConfigurationError):
        fx.config(SEAL_CA_DER="not-base64!")
    with pytest.raises(ConfigurationError):
        fx.config(VALIDATOR_MAX_SEALED_BYTES=str(65 * 1024 * 1024))


# --- HTTP boundary ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def http_server(fx: Fixture):  # type: ignore[no-untyped-def]
    server = ValidatorServer(("127.0.0.1", 0), fx.config())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()


def _headers(fx: Fixture, sealed: bytes, **overrides: str) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": MEDIA_TYPE,
        "Idempotency-Key": "val-1",
        "X-SignKit-Validation-Id": "val-1",
        "X-SignKit-Operation-Id": "op-1",
        "X-SignKit-Requested-Profile": "pades-b-b",
        "X-SignKit-Seal-Policy-Id": "seal-policy-1",
        "X-SignKit-Validation-Policy-Id": "validation-policy-1",
        "X-SignKit-Signer-Certificate-Sha256": fx.signer.fingerprint(hashes.SHA256()).hex(),
        "X-SignKit-Source-Sha256": hashlib.sha256(fx.source).hexdigest(),
        "X-SignKit-Source-Byte-Size": str(len(fx.source)),
        "X-SignKit-Sealed-Sha256": hashlib.sha256(sealed).hexdigest(),
        "X-SignKit-Sealed-Byte-Size": str(len(sealed)),
    }
    headers.update(overrides)
    return headers


def _put(
    server: ValidatorServer, headers: dict[str, str], body: bytes, path: str = "/pdf-seal-validations/val-1"
) -> tuple[int, dict[str, object]]:
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=60)
    try:
        connection.request("PUT", path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def test_healthz_is_unauthenticated(http_server: ValidatorServer) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", http_server.server_address[1])
    connection.request("GET", "/healthz")
    assert connection.getresponse().status == 200


def test_http_valid_response_echoes_frozen_fields_and_stable_receipt(
    fx: Fixture, sealed: bytes, http_server: ValidatorServer
) -> None:
    status, first = _put(http_server, _headers(fx, sealed), fx.source + sealed)
    _, second = _put(http_server, _headers(fx, sealed), fx.source + sealed)
    assert status == 200 and first["status"] == "valid"
    assert first["tsaPolicyId"] is None and first["tsaTrustBundleSha256"] is None
    assert first["validationId"] == "val-1" and first["achievedProfile"] == "pades-b-b"
    assert first["checks"]["timestamp"] is None and first["checks"]["cmsSubFilter"] == "ETSI.CAdES.detached"
    assert first == second


def test_http_invalid_document_is_a_200_with_allowlisted_codes_only(
    fx: Fixture, sealed: bytes, http_server: ValidatorServer
) -> None:
    bad = sealed + b"%x\n"
    status, body = _put(http_server, _headers(fx, bad), fx.source + bad)
    assert status == 200 and body["status"] == "invalid"
    assert set(body) >= {"failureCodes", "validatorReceiptId"} and "checks" not in body


def test_http_rejects_bad_token_without_detail(
    fx: Fixture, sealed: bytes, http_server: ValidatorServer
) -> None:
    status, body = _put(
        http_server, _headers(fx, sealed, Authorization="Bearer wrong"), fx.source + sealed
    )
    assert status == 401 and body == {"error": "unauthorized"}


def test_http_rejects_digest_and_length_mismatch_and_tsa_headers(
    fx: Fixture, sealed: bytes, http_server: ValidatorServer
) -> None:
    status, _ = _put(
        http_server, _headers(fx, sealed, **{"X-SignKit-Source-Sha256": "0" * 64}), fx.source + sealed
    )
    assert status == 422
    status, _ = _put(http_server, _headers(fx, sealed), fx.source + sealed[:-1])
    assert status == 400
    status, _ = _put(
        http_server, _headers(fx, sealed, **{"X-SignKit-Tsa-Policy-Id": "tsa"}), fx.source + sealed
    )
    assert status == 400
    status, _ = _put(http_server, _headers(fx, sealed), fx.source + sealed, path="/pdf-seal-validations/other")
    assert status == 400


def test_http_oversized_sealed_declaration_is_rejected(
    fx: Fixture, sealed: bytes, http_server: ValidatorServer
) -> None:
    status, _ = _put(
        http_server,
        _headers(fx, sealed, **{"X-SignKit-Sealed-Byte-Size": str(65 * 1024 * 1024)}),
        b"",
    )
    assert status == 413
