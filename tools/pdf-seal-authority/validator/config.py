"""Environment-driven, fail-closed configuration for the independent seal validator."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass

from asn1crypto import x509 as asn1_x509

SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SEALED_BYTES_HARD = 64 * 1024 * 1024
MIN_TOKEN_BYTES = 32


class ConfigurationError(Exception):
    """Detail-free startup failure; never carries a configured value."""


@dataclass(frozen=True)
class Config:
    token: bytes
    ca_certificate: asn1_x509.Certificate
    ca_sha256: str
    signer_certificate_sha256: str
    seal_policy_id: str
    validation_policy_id: str
    max_source_bytes: int
    max_sealed_bytes: int
    max_concurrency: int
    body_deadline_seconds: float


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value:
        raise ConfigurationError(f"{name} is required")
    return value


def _integer(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    if not re.fullmatch(r"[1-9][0-9]*", raw):
        raise ConfigurationError(f"{name} is invalid")
    value = int(raw)
    if value < low or value > high:
        raise ConfigurationError(f"{name} is out of range")
    return value


def load_config(env: Mapping[str, str]) -> Config:
    token = _required(env, "VALIDATOR_TOKEN").encode("utf-8")
    if len(token) < MIN_TOKEN_BYTES:
        raise ConfigurationError("VALIDATOR_TOKEN is too short")
    try:
        ca_der = base64.b64decode(_required(env, "SEAL_CA_DER"), validate=True)
        ca = asn1_x509.Certificate.load(ca_der)
        if ca.dump() != ca_der or not ca.ca:
            raise ValueError("not a canonical CA certificate")
    except (binascii.Error, ValueError, TypeError) as error:
        raise ConfigurationError("SEAL_CA_DER is invalid") from error
    signer_sha256 = _required(env, "SEAL_CERTIFICATE_SHA256")
    if not SHA256_PATTERN.fullmatch(signer_sha256):
        raise ConfigurationError("SEAL_CERTIFICATE_SHA256 must be lowercase SHA-256 hex")
    seal_policy_id = _required(env, "SEAL_POLICY_ID")
    validation_policy_id = _required(env, "VALIDATION_POLICY_ID")
    if not IDENTIFIER_PATTERN.fullmatch(seal_policy_id) or not IDENTIFIER_PATTERN.fullmatch(
        validation_policy_id
    ):
        raise ConfigurationError("policy identifiers are invalid")
    return Config(
        token=token,
        ca_certificate=ca,
        ca_sha256=hashlib.sha256(ca_der).hexdigest(),
        signer_certificate_sha256=signer_sha256,
        seal_policy_id=seal_policy_id,
        validation_policy_id=validation_policy_id,
        max_source_bytes=MAX_SOURCE_BYTES,
        max_sealed_bytes=_integer(
            env, "VALIDATOR_MAX_SEALED_BYTES", MAX_SEALED_BYTES_HARD, 1, MAX_SEALED_BYTES_HARD
        ),
        max_concurrency=_integer(env, "VALIDATOR_MAX_CONCURRENCY", 2, 1, 16),
        body_deadline_seconds=float(_integer(env, "VALIDATOR_BODY_DEADLINE_SECONDS", 60, 1, 120)),
    )
