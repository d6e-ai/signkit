"""Private engine's RSA signing endpoint on the organization's PKCS#11 HSM host."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sys
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Callable, Mapping

import pkcs11
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pkcs11 import Attribute, KeyType, Mechanism, ObjectClass

TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
KEY_ID = re.compile(r"[A-Za-z0-9:_./+=-]{1,128}")
FINGERPRINT = re.compile(r"[0-9a-f]{64}")
UUID_V7 = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
MAX_REQUEST_BYTES = 49_152
MAX_MESSAGE_BYTES = 32_768


@dataclass(frozen=True, repr=False)
class Config:
    token: str
    key_id: str
    fingerprint: str
    module: str
    serial: bytes
    object_id: bytes
    pin: str

    @classmethod
    def load(cls, env: Mapping[str, str]) -> Config:
        token = env["HSM_SIGNER_TOKEN"]
        key_id = env["HSM_SIGNER_KEY_ID"]
        fingerprint = env["HSM_SIGNER_FINGERPRINT"]
        module = env["HSM_PKCS11_MODULE"]
        serial = env["HSM_PKCS11_TOKEN_SERIAL"].encode("ascii")
        object_id = env["HSM_PKCS11_KEY_ID"]
        pin_file = Path(env["HSM_PKCS11_PIN_FILE"])
        if (
            not TOKEN.fullmatch(token)
            or not KEY_ID.fullmatch(key_id)
            or not FINGERPRINT.fullmatch(fingerprint)
            or not Path(module).is_absolute()
            or not 1 <= len(serial) <= 16
            or serial.strip() != serial
            or not re.fullmatch(r"(?:[A-Fa-f0-9]{2}){1,64}", object_id)
            or not pin_file.is_absolute()
        ):
            raise ValueError("invalid signer configuration")
        with pin_file.open("rb") as file:
            pin = file.read(1025)
        if len(pin) > 1024 or not (pin := pin.rstrip(b"\r\n")):
            raise ValueError("invalid PIN file")
        return cls(token, key_id, fingerprint, module, serial, bytes.fromhex(object_id), pin.decode("utf-8"))


class HardwareSigner:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.library = pkcs11.lib(config.module)

    def __call__(self, message: bytes | None = None) -> bytes:
        token = self.library.get_token(token_serial=self.config.serial)
        with token.open(user_pin=self.config.pin) as session:
            public = session.get_key(
                object_class=ObjectClass.PUBLIC_KEY, key_type=KeyType.RSA, id=self.config.object_id
            )
            private = session.get_key(
                object_class=ObjectClass.PRIVATE_KEY, key_type=KeyType.RSA, id=self.config.object_id
            )
            modulus = bytes(public[Attribute.MODULUS])
            exponent = bytes(public[Attribute.PUBLIC_EXPONENT])
            if (
                modulus != bytes(private[Attribute.MODULUS])
                or exponent != bytes(private[Attribute.PUBLIC_EXPONENT])
                or not private[Attribute.TOKEN]
                or not private[Attribute.LOCAL]
                or not private[Attribute.SIGN]
                or not private[Attribute.SENSITIVE]
                or not private[Attribute.ALWAYS_SENSITIVE]
                or private[Attribute.EXTRACTABLE]
                or not private[Attribute.NEVER_EXTRACTABLE]
            ):
                raise ValueError("invalid hardware key")
            public_key = rsa.RSAPublicNumbers(
                int.from_bytes(exponent, "big"), int.from_bytes(modulus, "big")
            ).public_key()
            if public_key.key_size not in (2048, 3072, 4096):
                raise ValueError("unsupported RSA key size")
            spki = public_key.public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            if not hmac.compare_digest(hashlib.sha256(spki).hexdigest(), self.config.fingerprint):
                raise ValueError("unexpected hardware key")
            if message is None:  # Startup check does not use the private key.
                return b""
            return bytes(private.sign(message, mechanism=Mechanism.SHA256_RSA_PKCS))


def parse_request(body: bytes) -> tuple[str, bytes]:
    request = json.loads(body.decode("utf-8"))
    if not isinstance(request, dict) or set(request) != {"operationId", "message"}:
        raise ValueError("invalid request")
    operation_id, message = request["operationId"], request["message"]
    if not isinstance(operation_id, str) or not UUID_V7.fullmatch(operation_id):
        raise ValueError("invalid operation ID")
    if not isinstance(message, str):
        raise ValueError("invalid message")
    decoded = base64.b64decode(message, validate=True)
    if not 0 < len(decoded) <= MAX_MESSAGE_BYTES or base64.b64encode(decoded).decode() != message:
        raise ValueError("invalid message")
    return operation_id, decoded


def key_use_log(request_id: str, operation_id: str, outcome: str) -> None:
    print(json.dumps({
        "event": "pdf_seal_hsm_sign",
        "requestId": request_id,
        "operationId": operation_id,
        "outcome": outcome,
    }), flush=True)


def make_server(
    config: Config,
    sign: Callable[[bytes], bytes],
    port: int = 8079,
    log_use: Callable[[str, str, str], None] = key_use_log,
) -> HTTPServer:
    expected = f"Bearer {config.token}".encode("ascii")

    class Handler(BaseHTTPRequestHandler):
        def setup(self) -> None:
            self.request.settimeout(5)
            super().setup()

        def log_message(self, format: str, *args: object) -> None:
            pass  # Do not log request lines or headers.

        def respond(self, status: int, value: dict[str, str]) -> None:
            body = json.dumps(value, separators=(",", ":")).encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path != "/api/sign":
                self.respond(404, {"error": "not_found"})
                return
            authorization = self.headers.get_all("Authorization", [])
            candidate = authorization[0].encode("latin-1") if len(authorization) == 1 else b""
            if not hmac.compare_digest(candidate, expected):
                self.respond(401, {"error": "unauthorized"})
                return
            content_type = self.headers.get_all("Content-Type", [])
            if len(content_type) != 1 or content_type[0].split(";", 1)[0].strip().lower() != "application/json":
                self.respond(415, {"error": "unsupported_media_type"})
                return
            lengths = self.headers.get_all("Content-Length", [])
            if (
                self.headers.get("Transfer-Encoding") is not None
                or len(lengths) != 1
                or not re.fullmatch(r"[1-9][0-9]{0,9}", lengths[0])
            ):
                self.respond(400, {"error": "invalid_request"})
                return
            length = int(lengths[0])
            if length > MAX_REQUEST_BYTES:
                self.respond(413, {"error": "payload_too_large"})
                return
            try:
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError("incomplete request")
                operation_id, message = parse_request(body)
            except (OSError, ValueError, RecursionError):
                self.respond(400, {"error": "invalid_request"})
                return
            request_id = os.urandom(32).hex()
            log_use(request_id, operation_id, "attempted")
            try:
                signature = sign(message)
            except (pkcs11.PKCS11Error, ValueError, OSError):
                log_use(request_id, operation_id, "failed")
                self.respond(502, {"error": "sign_failed", "requestId": request_id})
                return
            log_use(request_id, operation_id, "signed")
            self.respond(200, {
                "keyId": config.key_id,
                "algorithm": "RS256",
                "fingerprint": config.fingerprint,
                "signature": base64.b64encode(signature).decode("ascii"),
                "requestId": request_id,
            })

    return HTTPServer(("127.0.0.1", port), Handler)


def main() -> None:
    try:
        config = Config.load(os.environ)
        signer = HardwareSigner(config)
        signer()
    except (KeyError, OSError, ValueError, pkcs11.PKCS11Error):
        sys.exit("invalid HSM signer configuration or unavailable key")
    with make_server(config, signer) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
