"""Reject ambiguous configuration instead of silently picking a signing key."""

from __future__ import annotations

import base64
import hashlib
import json

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

import seal_engine as se
from test_seal_engine import ARN, minimal_pdf, pki, sha  # noqa: F401 (fixture)
from test_vercel_adapter import FINGERPRINT, KEY_ID, OP_ID, SIGNER_TOKEN, URL

AWS = {"AWS_KMS_KEY_ARN": ARN}
VERCEL = {
    "VERCEL_SIGNER_URL": URL,
    "VERCEL_SIGNER_TOKEN": SIGNER_TOKEN,
    "VERCEL_KMS_KEY_ID": KEY_ID,
    "VERCEL_KMS_FINGERPRINT": FINGERPRINT,
}


def hsm_settings(identity):
    return {
        "SEAL_KEY_BACKEND": "pkcs11-hsm",
        "HSM_SIGNER_URL": "https://hsm.example.com/api/sign",
        "HSM_SIGNER_TOKEN": SIGNER_TOKEN,
        "HSM_SIGNER_KEY_ID": "hsm-key-1",
        "HSM_SIGNER_FINGERPRINT": hashlib.sha256(identity.public_key_der).hexdigest(),
    }


@pytest.mark.parametrize("explicit", [True, False])
@pytest.mark.parametrize("name, group, type_", [
    ("aws-kms", AWS, se.AwsKmsAdapter),
    ("vercel-kms", VERCEL, se.RemoteSigningAdapter),
])
def test_existing_backends_remain_supported(pki, explicit, name, group, type_):
    env = {**group, **({"SEAL_KEY_BACKEND": name} if explicit else {})}
    assert isinstance(se.load_signing_adapter(env, pki[0]), type_)


@pytest.mark.parametrize("env", [
    {},
    {**AWS, **VERCEL},
    {**AWS, "SEAL_KEY_BACKEND": "vercel-kms"},
    {**VERCEL, "SEAL_KEY_BACKEND": ""},
    {**AWS, "SEAL_KEY_BACKEND": "pkcs11-hsm"},
    {**AWS, "VERCEL_SIGNER_TOKEN": SIGNER_TOKEN},
    {**AWS, "AWS_ACCESS_KEY_ID": "test-only"},
    {"VERCEL_SIGNER_URL": URL},
    {"HSM_SIGNER_URL": "https://hsm.example.com/api/sign"},
])
def test_invalid_backend_configuration_fails_closed(pki, env):
    with pytest.raises(ValueError):
        se.load_signing_adapter(env, pki[0])


@pytest.mark.parametrize("changes", [
    {"HSM_SIGNER_URL": "http://hsm.example.com/api/sign"},
    {"HSM_SIGNER_URL": "https://127.0.0.1/api/sign"},
    {"HSM_SIGNER_URL": "https://hsm.example.com/api/sign?redirect=1"},
    {"HSM_SIGNER_URL": "https://user@hsm.example.com/api/sign"},
    {"HSM_SIGNER_FINGERPRINT": "0" * 64},
    {"HSM_SIGNER_TOKEN": "short"},
    {"HSM_SIGNER_KEY_ID": ""},
    {"SEAL_KEY_BACKEND": "vercel-kms"},
    VERCEL,
])
def test_hsm_configuration_pins_endpoint_and_certificate_key(pki, changes):
    with pytest.raises(ValueError):
        se.load_signing_adapter({**hsm_settings(pki[0]), **changes}, pki[0])


def test_hsm_adapter_seals_with_a_single_remote_call(pki, monkeypatch):
    identity, key = pki
    calls = []

    def transport(config, body):
        request = json.loads(body)
        assert request["operationId"] == OP_ID
        attributes = base64.b64decode(request["message"], validate=True)
        assert attributes.startswith(b"\x31")  # CMS signed-attribute DER SET
        calls.append(config.url)
        return se.SignerHttpResponse(200, "application/json", json.dumps({
            "keyId": config.key_id,
            "fingerprint": config.fingerprint,
            "algorithm": "RS256",
            "signature": base64.b64encode(key.sign(attributes, padding.PKCS1v15(), hashes.SHA256())).decode(),
            "requestId": "hsm-use-1",
        }).encode())

    from functools import partial
    monkeypatch.setattr(se, "RemoteSigningAdapter", partial(se.RemoteSigningAdapter, transport=transport))
    engine = se.Engine(identity, se.load_signing_adapter(hsm_settings(identity), identity))
    pdf = minimal_pdf()
    with pytest.raises(se.EngineError, match="bad_operation_id"):
        engine.seal(pdf, sha(pdf), identity.leaf_sha256)
    assert calls == []
    sealed, request_id = engine.seal(pdf, sha(pdf), identity.leaf_sha256, OP_ID)
    assert request_id == "hsm-use-1" and sealed.startswith(pdf) and b"ETSI.CAdES.detached" in sealed
    assert calls == ["https://hsm.example.com/api/sign"]
