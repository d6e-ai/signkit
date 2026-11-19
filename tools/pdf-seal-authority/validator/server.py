"""HTTP boundary for the independent PAdES B-B seal validator (0.0.0.0:8080)."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote

from config import (
    IDENTIFIER_PATTERN,
    SHA256_PATTERN,
    Config,
    ConfigurationError,
    load_config,
)
from engine import Outcome, Reference, evaluate

MEDIA_TYPE = "application/vnd.signkit.pdf-seal-validation-v1"
PATH_PATTERN = re.compile(r"^/pdf-seal-validations/([^/?#]+)$")
SIZE_PATTERN = re.compile(r"^(0|[1-9][0-9]{0,15})$")
MAX_LINE = 512
MAX_HEADER_BYTES_TRAILER = 4096
SOCKET_TIMEOUT_SECONDS = 30


class RequestError(Exception):
    def __init__(self, status: int, code: str, retry_after: int | None = None) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def receipt_id(
    config: Config, frozen: dict[str, Any], status: str, failure_codes: list[str]
) -> str:
    """Deterministic receipt: identical input and policy yield an identical receipt."""
    canonical = json.dumps(
        {
            "v": 1,
            "ca": config.ca_sha256,
            "frozen": frozen,
            "status": status,
            "failureCodes": failure_codes,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return "pdfv1:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_response(config: Config, frozen: dict[str, Any], outcome: Outcome) -> dict[str, Any]:
    body: dict[str, Any] = dict(frozen)
    if outcome.valid:
        body.update(
            status="valid",
            achievedProfile="pades-b-b",
            validatorReceiptId=receipt_id(config, frozen, "valid", []),
            checks={
                "sourcePrefixExact": outcome.checks["sourcePrefixExact"],
                "incrementalUpdateValid": outcome.checks["incrementalUpdateValid"],
                "byteRangeComplete": outcome.checks["byteRangeComplete"],
                "cmsSignatureValid": outcome.checks["cmsSignatureValid"],
                "cmsSubFilter": "ETSI.CAdES.detached",
                "signerCertificateProtected": outcome.checks["signerCertificateProtected"],
                "signerCertificateDigestMatches": outcome.checks["signerCertificateDigestMatches"],
                "certificatePathValid": outcome.checks["certificatePathValid"],
                "sealPolicyValid": outcome.checks["sealPolicyValid"],
                "invisibleApprovalSignature": outcome.checks["invisibleApprovalSignature"],
                "docMdpAbsent": outcome.checks["docMdpAbsent"],
                "noPostSealChanges": outcome.checks["noPostSealChanges"],
                "timestamp": None,
            },
        )
    else:
        codes = outcome.ordered_failures()
        body.update(
            status="invalid",
            validatorReceiptId=receipt_id(config, frozen, "invalid", codes),
            failureCodes=codes,
        )
    return body


class Handler(BaseHTTPRequestHandler):
    server_version = "signkit-pdf-seal-validator"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT_SECONDS

    @property
    def config(self) -> Config:
        return self.server.config  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return  # Request lines may carry validation identifiers; emit nothing.

    # --- responses -------------------------------------------------------------------------
    def _send_json(self, status: int, payload: dict[str, Any], extra: dict[str, str] | None = None) -> None:
        data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _send_error_code(self, error: RequestError) -> None:
        extra = {"Retry-After": str(error.retry_after)} if error.retry_after else None
        self._send_json(error.status, {"error": error.code}, extra)

    # --- routing ---------------------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_error_code(RequestError(404, "not_found"))

    def do_PUT(self) -> None:  # noqa: N802
        try:
            self._handle_put()
        except RequestError as error:
            self._send_error_code(error)
        except Exception:
            self._send_error_code(RequestError(500, "validator_unavailable"))

    def do_POST(self) -> None:  # noqa: N802
        self._send_error_code(RequestError(405, "method_not_allowed"))

    do_DELETE = do_PATCH = do_POST  # noqa: N815

    def handle_expect_100(self) -> bool:
        try:
            self._authenticate()
        except RequestError as error:
            self._send_error_code(error)
            return False
        return super().handle_expect_100()

    # --- request handling ------------------------------------------------------------------
    def _authenticate(self) -> None:
        presented = self.headers.get("Authorization", "")
        expected = b"Bearer " + self.config.token
        # Hash first so comparison time is independent of the presented token's length.
        left = hashlib.sha256(presented.encode("utf-8", "replace")).digest()
        right = hashlib.sha256(expected).digest()
        if not hmac.compare_digest(left, right):
            raise RequestError(401, "unauthorized")

    def _frozen_reference(self, validation_id: str) -> dict[str, Any]:
        headers = self.headers

        def get(name: str) -> str:
            values = headers.get_all(name)
            if values is None or len(values) != 1:
                raise RequestError(400, "invalid_request")
            return values[0]

        def identifier(name: str) -> str:
            value = get(name)
            if not IDENTIFIER_PATTERN.fullmatch(value):
                raise RequestError(400, "invalid_request")
            return value

        def digest(name: str) -> str:
            value = get(name)
            if not SHA256_PATTERN.fullmatch(value):
                raise RequestError(400, "invalid_request")
            return value

        def size(name: str) -> int:
            value = get(name)
            if not SIZE_PATTERN.fullmatch(value):
                raise RequestError(400, "invalid_request")
            return int(value)

        if (
            identifier("x-signkit-validation-id") != validation_id
            or identifier("idempotency-key") != validation_id
        ):
            raise RequestError(400, "invalid_request")
        if get("x-signkit-requested-profile") != "pades-b-b":
            raise RequestError(400, "unsupported_profile")
        if (
            headers.get("x-signkit-tsa-policy-id") is not None
            or headers.get("x-signkit-tsa-trust-bundle-sha256") is not None
        ):
            raise RequestError(400, "unsupported_profile")
        frozen: dict[str, Any] = {
            "validationId": validation_id,
            "operationId": identifier("x-signkit-operation-id"),
            "sourceSha256": digest("x-signkit-source-sha256"),
            "sourceByteSize": size("x-signkit-source-byte-size"),
            "sealedSha256": digest("x-signkit-sealed-sha256"),
            "sealedByteSize": size("x-signkit-sealed-byte-size"),
            "requestedProfile": "pades-b-b",
            "signerCertificateSha256": digest("x-signkit-signer-certificate-sha256"),
            "sealPolicyId": identifier("x-signkit-seal-policy-id"),
            "validationPolicyId": identifier("x-signkit-validation-policy-id"),
            "tsaPolicyId": None,
            "tsaTrustBundleSha256": None,
        }
        if not 1 <= frozen["sourceByteSize"] <= self.config.max_source_bytes:
            raise RequestError(413, "payload_too_large")
        if not 1 <= frozen["sealedByteSize"] <= self.config.max_sealed_bytes:
            raise RequestError(413, "payload_too_large")
        if frozen["sealedByteSize"] <= frozen["sourceByteSize"]:
            raise RequestError(400, "invalid_request")
        return frozen

    def _handle_put(self) -> None:
        self._authenticate()  # before any other header or body processing
        if "?" in self.path:
            raise RequestError(400, "invalid_request")
        match = PATH_PATTERN.fullmatch(self.path)
        if match is None:
            raise RequestError(404, "not_found")
        validation_id = unquote(match.group(1))
        if not IDENTIFIER_PATTERN.fullmatch(validation_id):
            raise RequestError(400, "invalid_request")
        content_type = (self.headers.get("Content-Type") or "").strip().lower()
        if content_type != MEDIA_TYPE:
            raise RequestError(415, "unsupported_media_type")
        encoding = (self.headers.get("Content-Encoding") or "identity").strip().lower()
        if encoding != "identity":
            raise RequestError(415, "unsupported_media_type")
        frozen = self._frozen_reference(validation_id)
        total = frozen["sourceByteSize"] + frozen["sealedByteSize"]

        if not self._try_acquire():
            raise RequestError(429, "rate_limited", retry_after=5)
        try:
            body = self._read_body(total)
            source = bytes(body[: frozen["sourceByteSize"]])
            sealed = bytes(body[frozen["sourceByteSize"] :])
            del body
            if (
                hashlib.sha256(source).hexdigest() != frozen["sourceSha256"]
                or hashlib.sha256(sealed).hexdigest() != frozen["sealedSha256"]
            ):
                raise RequestError(422, "digest_mismatch")
            outcome = evaluate(
                self.config,
                Reference(
                    frozen["sealPolicyId"],
                    frozen["validationPolicyId"],
                    frozen["signerCertificateSha256"],
                ),
                source,
                sealed,
            )
        finally:
            self.server.slots.release()  # type: ignore[attr-defined]
        self._send_json(200, build_response(self.config, frozen, outcome))

    def _try_acquire(self) -> bool:
        return self.server.slots.acquire(blocking=False)  # type: ignore[attr-defined]

    # --- bounded body ----------------------------------------------------------------------
    def _read_body(self, expected: int) -> bytearray:
        deadline = time.monotonic() + self.config.body_deadline_seconds
        transfer = (self.headers.get("Transfer-Encoding") or "").strip().lower()
        length_header = self.headers.get("Content-Length")
        if transfer:
            if transfer != "chunked" or length_header is not None:
                raise RequestError(400, "invalid_request")
            return self._read_chunked(expected, deadline)
        if length_header is None or not SIZE_PATTERN.fullmatch(length_header):
            raise RequestError(411, "length_required")
        if int(length_header) != expected:
            raise RequestError(400, "invalid_request")
        buffer = bytearray()
        while len(buffer) < expected:
            self._check_deadline(deadline)
            chunk = self.rfile.read(min(1 << 20, expected - len(buffer)))
            if not chunk:
                raise RequestError(400, "invalid_request")
            buffer.extend(chunk)
        return buffer

    def _read_chunked(self, expected: int, deadline: float) -> bytearray:
        buffer = bytearray()
        while True:
            self._check_deadline(deadline)
            line = self.rfile.readline(MAX_LINE + 1)
            if len(line) > MAX_LINE or not line.endswith(b"\r\n"):
                raise RequestError(400, "invalid_request")
            size_text = line[:-2]
            if not re.fullmatch(rb"[0-9a-fA-F]{1,8}", size_text):  # no chunk extensions
                raise RequestError(400, "invalid_request")
            size = int(size_text, 16)
            if size == 0:
                break
            if len(buffer) + size > expected:
                raise RequestError(400, "invalid_request")
            remaining = size
            while remaining:
                self._check_deadline(deadline)
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    raise RequestError(400, "invalid_request")
                buffer.extend(chunk)
                remaining -= len(chunk)
            if self.rfile.read(2) != b"\r\n":
                raise RequestError(400, "invalid_request")
        trailer_bytes = 0
        while True:  # discard bounded trailers up to the terminating blank line
            line = self.rfile.readline(MAX_LINE + 1)
            trailer_bytes += len(line)
            if len(line) > MAX_LINE or trailer_bytes > MAX_HEADER_BYTES_TRAILER or not line.endswith(b"\r\n"):
                raise RequestError(400, "invalid_request")
            if line == b"\r\n":
                break
        if len(buffer) != expected:
            raise RequestError(400, "invalid_request")
        return buffer

    @staticmethod
    def _check_deadline(deadline: float) -> None:
        if time.monotonic() > deadline:
            raise RequestError(408, "request_timeout")


class ValidatorServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address: tuple[str, int], config: Config) -> None:
        super().__init__(address, Handler)
        self.config = config
        self.slots = threading.BoundedSemaphore(config.max_concurrency)


def main() -> None:
    try:
        config = load_config(os.environ)
    except ConfigurationError as error:
        print(f"validator configuration error: {error}", file=sys.stderr)
        raise SystemExit(78) from None
    server = ValidatorServer(("0.0.0.0", 8080), config)
    server.serve_forever()


if __name__ == "__main__":
    main()
