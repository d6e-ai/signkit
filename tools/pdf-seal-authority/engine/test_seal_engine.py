"""Local tests: throwaway in-memory keys and a fake KMS; no AWS, no network beyond loopback.

Run from this directory: ``python -m pytest`` (needs requirements.txt plus pytest).
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils
from cryptography.x509.oid import NameOID

import seal_engine as se

ARN = "arn:aws:kms:eu-west-1:111122223333:key/00000000-0000-4000-8000-000000000000"
TOKEN = "t" * 40


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _cert(subject, issuer, key, signer_key, ca: bool) -> x509.Certificate:
    now = datetime.now(UTC)
    builder = (
        x509.CertificateBuilder()
        .subject_name(_name(subject))
        .issuer_name(_name(issuer))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(not ca, not ca, False, False, False, ca, ca, False, False),
            critical=True,
        )
    )
    return builder.sign(signer_key, hashes.SHA256())


@pytest.fixture(scope="module")
def pki():
    ca_key = rsa.generate_private_key(65537, 2048)
    leaf_key = rsa.generate_private_key(65537, 2048)
    ca = _cert("test ca", "test ca", ca_key, ca_key, True)
    leaf = _cert("test seal", "test ca", leaf_key, ca_key, False)
    der = lambda c: c.public_bytes(serialization.Encoding.DER)  # noqa: E731
    identity = se.Identity.load(der(leaf), der(ca))
    return identity, leaf_key


class FakeKms:
    def __init__(self, identity, key, **override):
        self.identity, self.key, self.override = identity, key, override
        self.sign_calls = 0
        self.public_calls = 0

    def get_public_key(self, KeyId):
        self.public_calls += 1
        r = {
            "KeyId": ARN,
            "KeyUsage": "SIGN_VERIFY",
            "KeySpec": "RSA_2048",
            "SigningAlgorithms": [se.KMS_ALGORITHM],
            "PublicKey": self.identity.public_key_der,
        }
        r.update(self.override.get("public", {}))
        return r

    def sign(self, KeyId, Message, MessageType, SigningAlgorithm):
        self.sign_calls += 1
        assert (KeyId, MessageType, SigningAlgorithm) == (ARN, "DIGEST", se.KMS_ALGORITHM)
        sig = self.key.sign(Message, padding.PKCS1v15(), utils.Prehashed(hashes.SHA256()))
        r = {
            "KeyId": ARN,
            "SigningAlgorithm": se.KMS_ALGORITHM,
            "Signature": sig,
            "ResponseMetadata": {"RequestId": "req-1"},
        }
        r.update(self.override.get("sign", {}))
        return r


def minimal_pdf() -> bytes:
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 4\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def engine_for(pki, **override):
    identity, key = pki
    kms = FakeKms(identity, key, **override)
    return se.Engine(identity, se.AwsKmsAdapter(ARN, lambda: kms)), kms


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def test_success_exactly_one_sign_and_incremental(pki):
    engine, kms = engine_for(pki)
    pdf = minimal_pdf()
    out, rid = engine.seal(pdf, sha(pdf), pki[0].leaf_sha256)
    assert (kms.sign_calls, rid) == (1, "req-1")
    assert out.startswith(pdf) and b"ETSI.CAdES.detached" in out


def test_independent_validator_accepts_engine_output(pki, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "validator"))
    from config import load_config
    from engine import Reference, evaluate

    identity, _ = pki
    engine, kms = engine_for(pki)
    source = minimal_pdf()
    sealed, _ = engine.seal(source, sha(source), identity.leaf_sha256)
    config = load_config({
        "VALIDATOR_TOKEN": TOKEN,
        "SEAL_CA_DER": base64.b64encode(identity.chain_der[-1]).decode(),
        "SEAL_CERTIFICATE_SHA256": identity.leaf_sha256,
        "SEAL_POLICY_ID": "test-seal",
        "VALIDATION_POLICY_ID": "test-validator",
    })
    result = evaluate(config, Reference("test-seal", "test-validator", identity.leaf_sha256), source, sealed)
    assert result.valid, result.ordered_failures()
    assert kms.sign_calls == 1


def test_digest_mismatch_never_touches_kms(pki):
    engine, kms = engine_for(pki)
    pdf = minimal_pdf()
    with pytest.raises(se.EngineError) as e:
        engine.seal(pdf, sha(b"other"), pki[0].leaf_sha256)
    assert e.value.code == "source_digest_mismatch"
    assert (kms.sign_calls, kms.public_calls) == (0, 0)


def test_certificate_pin_mismatch(pki):
    engine, kms = engine_for(pki)
    pdf = minimal_pdf()
    with pytest.raises(se.EngineError):
        engine.seal(pdf, sha(pdf), "0" * 64)
    assert kms.sign_calls == 0


def test_unparseable_pdf_does_not_sign(pki):
    engine, kms = engine_for(pki)
    junk = b"not a pdf"
    with pytest.raises(se.EngineError) as e:
        engine.seal(junk, sha(junk), pki[0].leaf_sha256)
    assert e.value.code == "pdf_rejected" and kms.sign_calls == 0


@pytest.mark.parametrize(
    "override",
    [
        {"sign": {"KeyId": "arn:aws:kms:eu-west-1:111122223333:key/other"}},
        {"sign": {"SigningAlgorithm": "RSASSA_PSS_SHA_256"}},
        {"sign": {"Signature": b"\x00" * 100}},
        {"sign": {"Signature": b"\x00" * 256}},
        {"sign": {"ResponseMetadata": {}}},
    ],
)
def test_kms_response_is_proven(pki, override):
    engine, kms = engine_for(pki, **override)
    pdf = minimal_pdf()
    with pytest.raises(se.EngineError) as e:
        engine.seal(pdf, sha(pdf), pki[0].leaf_sha256)
    assert e.value.status == 502 and kms.sign_calls == 1


@pytest.mark.parametrize(
    "public",
    [
        {"PublicKey": b"x"},
        {"KeyUsage": "ENCRYPT_DECRYPT"},
        {"SigningAlgorithms": []},
        {"KeyId": "other"},
    ],
)
def test_public_key_must_match_certificate_before_sign(pki, public):
    engine, kms = engine_for(pki, public=public)
    pdf = minimal_pdf()
    with pytest.raises(se.EngineError) as e:
        engine.seal(pdf, sha(pdf), pki[0].leaf_sha256)
    assert e.value.code == "kms_key_certificate_mismatch" and kms.sign_calls == 0


def test_dry_run_never_calls_kms(pki):
    import asyncio

    identity, key = pki
    kms = FakeKms(identity, key)
    signer = se.KmsSigner(identity, kms, ARN)
    out = asyncio.run(signer.async_sign_raw(b"x", "sha256", dry_run=True))
    assert out == bytes(256) and kms.sign_calls == 0


def test_second_real_sign_refused(pki):
    import asyncio

    identity, key = pki
    kms = FakeKms(identity, key)
    signer = se.KmsSigner(identity, kms, ARN)
    asyncio.run(signer.async_sign_raw(b"x", "sha256"))
    with pytest.raises(se.EngineError):
        asyncio.run(signer.async_sign_raw(b"x", "sha256"))
    assert kms.sign_calls == 1


def test_key_arn_alias_refused():
    with pytest.raises(ValueError):
        se.kms_client_factory("alias/seal")


# ---- HTTP surface


@pytest.fixture()
def server(pki):
    engine, kms = engine_for(pki)
    srv = se.make_server(engine, TOKEN, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], kms
    srv.shutdown()


def post(port, body, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    base = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/pdf",
        "X-SignKit-Seal-Profile": "pades-b-b",
        "X-SignKit-Source-Sha256": sha(body),
    }
    base.update(headers or {})
    conn.request("POST", "/seal", body=body, headers=base)
    r = conn.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def test_http_healthz_and_success(server, pki):
    port, kms = server
    conn = http.client.HTTPConnection("127.0.0.1", port)
    conn.request("GET", "/healthz")
    assert conn.getresponse().status == 200
    pdf = minimal_pdf()
    status, headers, body = post(
        port, pdf, {"X-SignKit-Signer-Certificate-Sha256": pki[0].leaf_sha256}
    )
    assert status == 200 and kms.sign_calls == 1
    assert headers["x-signkit-kms-request-id"] == "req-1"
    assert int(headers["Content-Length"]) == len(body) and body.startswith(pdf)


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({"Authorization": f"Bearer {TOKEN}x"}, 401),
        ({"Authorization": ""}, 401),
        ({"X-SignKit-Seal-Profile": "pades-b-t"}, 422),
        ({"Content-Type": "application/octet-stream"}, 415),
        ({"X-SignKit-Source-Sha256": "A" * 64}, 400),
    ],
)
def test_http_refusals_do_not_sign(server, pki, headers, status):
    port, kms = server
    h = {"X-SignKit-Signer-Certificate-Sha256": pki[0].leaf_sha256, **headers}
    assert post(port, minimal_pdf(), h)[0] == status
    assert kms.sign_calls == 0


def test_http_oversize_length_refused_without_reading(server, pki):
    port, kms = server
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.putrequest("POST", "/seal")
    for k, v in {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/pdf",
        "X-SignKit-Seal-Profile": "pades-b-b",
        "X-SignKit-Source-Sha256": "0" * 64,
        "X-SignKit-Signer-Certificate-Sha256": pki[0].leaf_sha256,
        "Content-Length": str(se.MAX_BODY_BYTES + 1),
    }.items():
        conn.putheader(k, v)
    conn.endheaders()
    assert conn.getresponse().status == 413 and kms.sign_calls == 0
