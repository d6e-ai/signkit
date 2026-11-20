"""Vercel KMS adapter tests: injected fake transport, throwaway keys; no network, no credentials.

Run from this directory: ``python -m pytest``.
"""

from __future__ import annotations

import base64
import http.client
import json
import threading

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

import seal_engine as se
from test_seal_engine import TOKEN, minimal_pdf, pki, sha  # noqa: F401  (pki is a fixture)

URL = "https://signkit-signer.vercel.app/api/sign"
SIGNER_TOKEN = "s" * 43
KEY_ID = "vercel-key-1"
FINGERPRINT = "fp-abc123"
OP_ID = "0190a5c2-7b3e-7c11-8a22-123456789abc"


class FakeVercel:
    def __init__(self, key, mutate=None, status=200, content_type="application/json", raises=None):
        self.key, self.mutate, self.status = key, mutate, status
        self.content_type, self.raises = content_type, raises
        self.calls: list[tuple[se.VercelConfig, dict]] = []

    def __call__(self, config, body):
        self.calls.append((config, json.loads(body)))
        if self.raises:
            raise self.raises
        message = base64.b64decode(self.calls[-1][1]["message"])
        payload = {
            "keyId": KEY_ID,
            "algorithm": "RS256",
            "fingerprint": FINGERPRINT,
            "signature": base64.b64encode(
                self.key.sign(message, padding.PKCS1v15(), hashes.SHA256())
            ).decode(),
            "requestId": "vercel-req-1",
        }
        if self.mutate:
            self.mutate(payload)
        return se.SignerHttpResponse(
            self.status, self.content_type, json.dumps(payload).encode()
        )


def config() -> se.VercelConfig:
    return se.VercelConfig.load(URL, SIGNER_TOKEN, KEY_ID, FINGERPRINT)


def vercel_engine(pki, **kwargs):  # noqa: F811
    identity, key = pki
    transport = FakeVercel(key, **kwargs)
    return se.Engine(identity, se.RemoteSigningAdapter(config(), transport)), transport


def seal(engine, pki, operation_id=OP_ID):  # noqa: F811
    pdf = minimal_pdf()
    return pdf, engine.seal(pdf, sha(pdf), pki[0].leaf_sha256, operation_id)


def test_success_single_invocation_with_raw_attributes(pki):  # noqa: F811
    engine, transport = vercel_engine(pki)
    pdf, (out, rid) = seal(engine, pki)
    assert rid == "vercel-req-1" and out.startswith(pdf)
    assert b"ETSI.CAdES.detached" in out
    assert len(transport.calls) == 1
    cfg, body = transport.calls[0]
    assert cfg.token == SIGNER_TOKEN and cfg.url == URL
    assert set(body) == {"operationId", "message"} and body["operationId"] == OP_ID
    attrs = base64.b64decode(body["message"], validate=True)
    assert attrs[:1] == b"\x31"  # DER SET of signed attributes, not a 32-byte digest
    assert len(attrs) > 32


@pytest.mark.parametrize(
    "bad",
    [
        None,
        "",
        OP_ID.upper(),
        "0190a5c2-7b3e-4c11-8a22-123456789abc",  # v4
        "0190a5c2-7b3e-7c11-7a22-123456789abc",  # bad variant
        OP_ID + "0",
    ],
)
def test_operation_id_required_and_canonical(pki, bad):  # noqa: F811
    engine, transport = vercel_engine(pki)
    with pytest.raises(se.EngineError) as error:
        seal(engine, pki, bad)
    assert error.value.code == "bad_operation_id" and transport.calls == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p.update(keyId="other"),
        lambda p: p.update(algorithm="PS256"),
        lambda p: p.update(fingerprint="wrong"),
        lambda p: p.update(requestId=""),
        lambda p: p.update(requestId="bad id!"),
        lambda p: p.update(signature="not base64!"),
        lambda p: p.update(signature=base64.b64encode(b"short").decode()),
        lambda p: p.update(signature=p["signature"].rstrip("=") + "A"),
        lambda p: p.update(extra="field"),
        lambda p: p.pop("keyId"),
        lambda p: p.update(signature=12),
    ],
)
def test_malformed_or_mismatched_key_response_denied(pki, mutate):  # noqa: F811
    engine, transport = vercel_engine(pki, mutate=mutate)
    with pytest.raises(se.EngineError) as error:
        seal(engine, pki)
    assert error.value.status == 502 and error.value.code.startswith("kms_")
    assert len(transport.calls) == 1  # never retried


def test_wrong_signature_denied(pki):  # noqa: F811
    other = se.rsa.generate_private_key(65537, 2048)
    engine, transport = vercel_engine(pki)
    transport.key = other
    with pytest.raises(se.EngineError) as error:
        seal(engine, pki)
    assert error.value.code == "kms_signature_invalid"
    assert error.value.kms_request_id == "vercel-req-1" and len(transport.calls) == 1


@pytest.mark.parametrize(
    "kwargs",
    [
        {"status": 500},
        {"status": 302},
        {"content_type": "text/html"},
        {"raises": TimeoutError()},
    ],
)
def test_transport_and_status_failures_not_retried(pki, kwargs):  # noqa: F811
    engine, transport = vercel_engine(pki, **kwargs)
    with pytest.raises(se.EngineError) as error:
        seal(engine, pki)
    expected = "kms_response_rejected" if "content_type" in kwargs else "kms_sign_failed"
    assert error.value.code == expected and len(transport.calls) == 1


def test_digest_mismatch_never_invokes_vercel(pki):  # noqa: F811
    engine, transport = vercel_engine(pki)
    with pytest.raises(se.EngineError):
        engine.seal(minimal_pdf(), "0" * 64, pki[0].leaf_sha256, OP_ID)
    assert transport.calls == []


@pytest.mark.parametrize(
    ("url", "token", "key", "fp"),
    [
        ("http://a.vercel.app/api/sign", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://a.example.com/api/sign", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://a.vercel.app/api/sign?x=1", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://a.vercel.app:444/api/sign", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://u@a.vercel.app/api/sign", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://a.vercel.app/api/other", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        ("https://a.vercel.app/api/sign/", SIGNER_TOKEN, KEY_ID, FINGERPRINT),
        (URL, "s" * 42, KEY_ID, FINGERPRINT),
        (URL, "s" * 42 + " ", KEY_ID, FINGERPRINT),
        (URL, SIGNER_TOKEN, "", FINGERPRINT),
        (URL, SIGNER_TOKEN, KEY_ID, "bad fp"),
    ],
)
def test_config_rejected(url, token, key, fp):
    with pytest.raises(ValueError):
        se.VercelConfig.load(url, token, key, fp)


# ---- HTTP surface


@pytest.fixture()
def server(pki):  # noqa: F811
    engine, transport = vercel_engine(pki)
    srv = se.make_server(engine, TOKEN, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], transport
    srv.shutdown()


def post(port, pki, extra):  # noqa: F811
    pdf = minimal_pdf()
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/pdf",
        "X-SignKit-Seal-Profile": "pades-b-b",
        "X-SignKit-Source-Sha256": sha(pdf),
        "X-SignKit-Signer-Certificate-Sha256": pki[0].leaf_sha256,
        **extra,
    }
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    conn.request("POST", "/seal", body=pdf, headers=headers)
    r = conn.getresponse()
    return r.status, dict(r.getheaders()), r.read()


def test_http_forwards_operation_id_and_request_id(server, pki):  # noqa: F811
    port, transport = server
    status, headers, _ = post(port, pki, {"x-signkit-operation-id": OP_ID})
    assert status == 200 and headers["x-signkit-kms-request-id"] == "vercel-req-1"
    assert [body["operationId"] for _, body in transport.calls] == [OP_ID]


@pytest.mark.parametrize("value", [None, "nope", OP_ID.upper()])
def test_http_missing_or_bad_operation_id_refused(server, pki, value):  # noqa: F811
    port, transport = server
    status, _, _ = post(port, pki, {} if value is None else {"x-signkit-operation-id": value})
    assert status == 400 and transport.calls == []
