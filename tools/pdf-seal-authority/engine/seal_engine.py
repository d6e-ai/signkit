"""PAdES B-B seal engine backed by an AWS KMS asymmetric RSA key.

Deployment: private Cloudflare Container, reachable only through the trusted gate's private
binding (never app credentials, never a public route). Listens on 0.0.0.0:8080.

    GET  /healthz  -> 200 {"status":"ok"}; no secrets, no KMS call.
    POST /seal     -> exact ``Authorization: Bearer <ENGINE_TOKEN>`` (constant time).
        Content-Type: application/pdf, body <= 32 MiB (Content-Length optional, chunked bounded)
        X-SignKit-Seal-Profile: pades-b-b                 (anything else is refused)
        X-SignKit-Source-Sha256: <64 lowercase hex of the body>
        X-SignKit-Signer-Certificate-Sha256: <64 lowercase hex of the leaf DER>
      200 application/pdf (exact Content-Length) + x-signkit-kms-request-id.

Environment (public material and one non-secret key reference only; no private key is loaded):
    ENGINE_TOKEN           shared internal bearer secret, >= 32 chars
    SEAL_CERTIFICATE_DER   base64 DER leaf certificate
    SEAL_CA_DER            base64 concatenated DER private CA chain, issuer of the leaf first,
                           self-signed root last
    AWS_KMS_KEY_ARN        key ARN of a SIGN_VERIFY RSA key (aliases are refused)
    AWS credentials/region come from the container's standard AWS environment.

Opt-in Vercel KMS mode (exclusive with AWS_KMS_KEY_ARN; no AWS credentials or key here):
    VERCEL_SIGNER_URL      exactly https://<name>.vercel.app/api/sign
    VERCEL_SIGNER_TOKEN    43 base64url chars, sent as the bearer to the Vercel Function
    VERCEL_KMS_KEY_ID      expected keyId in the response
    VERCEL_KMS_FINGERPRINT expected fingerprint in the response
  /seal then requires one canonical lowercase UUIDv7 ``x-signkit-operation-id`` header. The
  single signing call is one no-redirect, no-retry, size/time-bounded HTTPS POST of
  {operationId, message=base64(CMS signed attributes)}; the {keyId, algorithm: RS256, fingerprint,
  signature, requestId} reply is checked and the signature verified against the leaf before use.
  requestId is returned as x-signkit-kms-request-id.

Guarantees per accepted operation: input is hashed and compared before any use; the dry-run
placeholder pass never calls KMS; exactly one ``Sign`` call (client retries disabled) is made;
the returned KeyId/SigningAlgorithm/signature length are checked and the signature is verified
against the certificate before it is embedded; the KMS public key must equal the certificate key
(checked once per process, retried on failure). Error bodies are fixed codes with no details; the
PDF and signature bytes are never logged or written to disk.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import io
import json
import os
import re
import signal
import ssl
import sys
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlsplit

import boto3
from asn1crypto import parser as asn1_parser
from asn1crypto import x509 as asn1_x509
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigSeedSubFilter
from pyhanko_certvalidator.registry import SimpleCertificateStore

MAX_BODY_BYTES = 32 * 1024 * 1024
PROFILE = "pades-b-b"
KMS_ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256"
FIELD_NAME = "SignKitInstanceSeal"
KEY_ARN_PATTERN = re.compile(
    r"arn:aws[a-z-]*:kms:([a-z0-9-]+):[0-9]{12}:key/[0-9a-zA-Z-]+"
)
HEX64 = re.compile(r"[0-9a-f]{64}")
UUID_V7 = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
VERCEL_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app")
VERCEL_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
VERCEL_FIELD = re.compile(r"[A-Za-z0-9:_./+=-]{1,128}")
VERCEL_REQUEST_ID = re.compile(r"[A-Za-z0-9:_.-]{1,128}")
VERCEL_MAX_RESPONSE = 16 * 1024
VERCEL_MAX_SIGNATURE_TEXT = 700  # base64 of a 4096-bit RSA signature is 684 characters
VERCEL_SOCKET_TIMEOUT = 5
VERCEL_TOTAL_TIMEOUT = 10


class EngineError(Exception):
    """Fixed-code failure; ``code`` is the only detail ever returned to the caller."""

    def __init__(
        self, status: int, code: str, kms_request_id: str | None = None
    ) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.kms_request_id = kms_request_id


# --------------------------------------------------------------------------- identity


def split_der_chain(data: bytes) -> list[bytes]:
    """Split concatenated DER certificates (definite-length SEQUENCEs only)."""
    out: list[bytes] = []
    pos = 0
    while pos < len(data):
        class_, _method, tag, header, content, _trailer = asn1_parser.parse(
            data[pos:], strict=False
        )
        if class_ != 0 or tag != 16:
            raise ValueError("chain entry is not a DER SEQUENCE")
        size = len(header) + len(content)
        out.append(data[pos : pos + size])
        pos += size
    if not out:
        raise ValueError("empty chain")
    return out


@dataclass(frozen=True)
class Identity:
    leaf: x509.Certificate
    leaf_der: bytes
    chain: tuple[x509.Certificate, ...]
    chain_der: tuple[bytes, ...]
    leaf_sha256: str
    public_key: rsa.RSAPublicKey
    public_key_der: bytes
    signature_length: int

    @classmethod
    def load(cls, leaf_der: bytes, ca_der: bytes) -> Identity:
        leaf = x509.load_der_x509_certificate(leaf_der)
        chain_der = tuple(split_der_chain(ca_der))
        chain = tuple(x509.load_der_x509_certificate(d) for d in chain_der)
        public_key = leaf.public_key()
        if not isinstance(public_key, rsa.RSAPublicKey):
            raise ValueError("leaf key is not RSA")
        if public_key.key_size not in (2048, 3072, 4096):
            raise ValueError("unsupported RSA key size")
        bc = _basic_constraints(leaf)
        if bc is not None and bc.ca:
            raise ValueError("leaf is a CA")
        usage = leaf.extensions.get_extension_for_class(x509.KeyUsage).value
        if not usage.digital_signature or not usage.content_commitment:
            raise ValueError("leaf key usage does not permit sealing")
        child = leaf
        for ca in chain:
            bc_ca = _basic_constraints(ca)
            if bc_ca is None or not bc_ca.ca:
                raise ValueError("chain member is not a CA")
            child.verify_directly_issued_by(ca)
            child = ca
        chain[-1].verify_directly_issued_by(chain[-1])  # root must be self-signed
        identity = cls(
            leaf=leaf,
            leaf_der=leaf_der,
            chain=chain,
            chain_der=chain_der,
            leaf_sha256=hashlib.sha256(leaf_der).hexdigest(),
            public_key=public_key,
            public_key_der=public_key.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            ),
            signature_length=(public_key.key_size + 7) // 8,
        )
        identity.assert_valid(datetime.now(UTC))
        return identity

    def assert_valid(self, now: datetime) -> None:
        for cert in (self.leaf, *self.chain):
            if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
                raise EngineError(409, "certificate_not_valid")


def _basic_constraints(cert: x509.Certificate) -> x509.BasicConstraints | None:
    try:
        return cert.extensions.get_extension_for_class(x509.BasicConstraints).value
    except x509.ExtensionNotFound:
        return None


# --------------------------------------------------------------------------- KMS


def kms_client_factory(key_arn: str) -> Callable[[], Any]:
    match = KEY_ARN_PATTERN.fullmatch(key_arn)
    if match is None:
        raise ValueError("AWS_KMS_KEY_ARN must be a KMS key ARN")
    region = match.group(1)

    def make() -> Any:
        # total_max_attempts=1: botocore never silently repeats a Sign.
        return boto3.client(
            "kms",
            region_name=region,
            config=Config(
                retries={"total_max_attempts": 1, "mode": "standard"},
                connect_timeout=2,
                read_timeout=5,
            ),
        )

    return make


def request_id(response: dict[str, Any]) -> str | None:
    value = (response.get("ResponseMetadata") or {}).get("RequestId")
    return value if isinstance(value, str) and 0 < len(value) <= 128 else None


class OneShotSigner(signers.Signer):
    """Common pyHanko signer: exactly one remote raw RSA PKCS#1 v1.5 SHA-256 signature.

    Subclasses implement ``_remote_sign`` (set ``kms_request_id`` as soon as it is known and
    return the checked-length signature); this class enforces dry-run/one-call and verifies the
    signature against the pinned leaf key before pyHanko embeds it.
    """

    def __init__(self, identity: Identity) -> None:
        store = SimpleCertificateStore()
        store.register_multiple(
            [asn1_x509.Certificate.load(der) for der in identity.chain_der]
        )
        super().__init__(
            prefer_pss=False,
            embed_roots=True,
            signing_cert=asn1_x509.Certificate.load(identity.leaf_der),
            cert_registry=store,
        )
        self._identity = identity
        self.sign_calls = 0
        self.kms_request_id: str | None = None

    def _remote_sign(self, data: bytes) -> bytes:
        raise NotImplementedError

    async def async_sign_raw(
        self, data: bytes, digest_algorithm: str, dry_run: bool = False
    ) -> bytes:
        if digest_algorithm.lower() != "sha256":
            raise EngineError(500, "unsupported_digest")
        if dry_run:
            return bytes(self._identity.signature_length)  # never touches KMS
        if self.sign_calls:
            raise EngineError(500, "second_sign_refused", self.kms_request_id)
        self.sign_calls = 1
        signature = self._remote_sign(data)
        try:
            self._identity.public_key.verify(
                signature, data, padding.PKCS1v15(), hashes.SHA256()
            )
        except InvalidSignature:
            raise EngineError(502, "kms_signature_invalid", self.kms_request_id) from None
        return signature


class KmsSigner(OneShotSigner):
    """Delegates the single signature to AWS KMS."""

    def __init__(self, identity: Identity, client: Any, key_arn: str) -> None:
        super().__init__(identity)
        self._client = client
        self._key_arn = key_arn

    def _remote_sign(self, data: bytes) -> bytes:
        try:
            response = self._client.sign(
                KeyId=self._key_arn,
                Message=hashlib.sha256(data).digest(),
                MessageType="DIGEST",
                SigningAlgorithm=KMS_ALGORITHM,
            )
        except (BotoCoreError, ClientError) as error:
            rid = None
            if isinstance(error, ClientError):
                rid = request_id(error.response)
            raise EngineError(502, "kms_sign_failed", rid) from None
        self.kms_request_id = request_id(response)
        signature = response.get("Signature")
        if (
            response.get("KeyId") != self._key_arn
            or response.get("SigningAlgorithm") != KMS_ALGORITHM
            or not isinstance(signature, bytes | bytearray)
            or len(signature) != self._identity.signature_length
            or self.kms_request_id is None
        ):
            raise EngineError(502, "kms_response_rejected", self.kms_request_id)
        return bytes(signature)


# --------------------------------------------------------------------------- Vercel KMS


@dataclass(frozen=True)
class VercelConfig:
    url: str
    host: str
    token: str
    key_id: str
    fingerprint: str

    @classmethod
    def load(cls, url: str, token: str, key_id: str, fingerprint: str) -> VercelConfig:
        parts = urlsplit(url)
        host = parts.hostname or ""
        if (
            parts.scheme != "https"
            or parts.path != "/api/sign"
            or parts.query
            or parts.fragment
            or parts.username is not None
            or parts.password is not None
            or parts.port is not None
            or not VERCEL_HOST.fullmatch(host)
            or url != f"https://{host}/api/sign"
        ):
            raise ValueError("VERCEL_SIGNER_URL must be https://<name>.vercel.app/api/sign")
        if not VERCEL_TOKEN.fullmatch(token):
            raise ValueError("VERCEL_SIGNER_TOKEN must be 43 base64url characters")
        if not VERCEL_FIELD.fullmatch(key_id) or not VERCEL_FIELD.fullmatch(fingerprint):
            raise ValueError("invalid VERCEL_KMS_KEY_ID or VERCEL_KMS_FINGERPRINT")
        return cls(url, host, token, key_id, fingerprint)


@dataclass(frozen=True)
class VercelHttpResponse:
    status: int
    content_type: str
    body: bytes


Transport = Callable[[VercelConfig, bytes], VercelHttpResponse]


def https_post(config: VercelConfig, body: bytes) -> VercelHttpResponse:
    """One bounded HTTPS POST: verified TLS, no redirect following, no retry, capped response."""
    deadline = time.monotonic() + VERCEL_TOTAL_TIMEOUT
    connection = http.client.HTTPSConnection(
        config.host,
        443,
        timeout=VERCEL_SOCKET_TIMEOUT,
        context=ssl.create_default_context(),
    )
    try:
        connection.request(
            "POST",
            "/api/sign",
            body=body,
            headers={
                "Authorization": f"Bearer {config.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Content-Length": str(len(body)),
                "Connection": "close",
            },
        )
        response = connection.getresponse()
        declared = response.getheader("Content-Length")
        if declared is not None and (
            not declared.isdigit() or int(declared) > VERCEL_MAX_RESPONSE
        ):
            raise ValueError("response too large")
        out = bytearray()
        while len(out) <= VERCEL_MAX_RESPONSE:
            if time.monotonic() > deadline:
                raise TimeoutError
            chunk = response.read(min(4096, VERCEL_MAX_RESPONSE + 1 - len(out)))
            if not chunk:
                break
            out += chunk
        if len(out) > VERCEL_MAX_RESPONSE:
            raise ValueError("response too large")
        return VercelHttpResponse(
            response.status, response.getheader("Content-Type") or "", bytes(out)
        )
    finally:
        connection.close()


class VercelSigner(OneShotSigner):
    """Delegates one signature to the dedicated Vercel Function authorized to use KMS."""

    def __init__(
        self,
        identity: Identity,
        config: VercelConfig,
        operation_id: str,
        transport: Transport = https_post,
    ) -> None:
        super().__init__(identity)
        self._config = config
        self._operation_id = operation_id
        self._transport = transport

    def _remote_sign(self, data: bytes) -> bytes:
        config = self._config
        request = json.dumps(
            {
                "operationId": self._operation_id,
                "message": base64.b64encode(data).decode("ascii"),
            },
            separators=(",", ":"),
        ).encode()
        try:
            response = self._transport(config, request)
        except Exception:  # network/TLS/timeout/oversize: no details, no retry
            raise EngineError(502, "kms_sign_failed") from None
        payload = _parse_vercel_json(response)
        rid = payload.get("requestId") if isinstance(payload, dict) else None
        if not (isinstance(rid, str) and VERCEL_REQUEST_ID.fullmatch(rid)):
            rid = None
        self.kms_request_id = rid
        if response.status != 200:
            raise EngineError(502, "kms_sign_failed", rid)
        signature_text = payload.get("signature") if isinstance(payload, dict) else None
        if (
            not isinstance(payload, dict)
            or set(payload) != {"keyId", "algorithm", "fingerprint", "signature", "requestId"}
            or rid is None
            or payload["keyId"] != config.key_id
            or payload["algorithm"] != "RS256"
            or not isinstance(payload["fingerprint"], str)
            or not hmac.compare_digest(
                payload["fingerprint"].encode(), config.fingerprint.encode()
            )
            or not isinstance(signature_text, str)
            or len(signature_text) > VERCEL_MAX_SIGNATURE_TEXT
        ):
            raise EngineError(502, "kms_response_rejected", rid)
        try:
            signature = base64.b64decode(signature_text, validate=True)
        except ValueError:
            raise EngineError(502, "kms_response_rejected", rid) from None
        if (
            len(signature) != self._identity.signature_length
            or base64.b64encode(signature).decode("ascii") != signature_text
        ):
            raise EngineError(502, "kms_response_rejected", rid)
        return signature


def _parse_vercel_json(response: VercelHttpResponse) -> Any:
    if not response.content_type.lower().startswith("application/json"):
        return None
    try:
        return json.loads(response.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def verify_kms_key(client: Any, identity: Identity, key_arn: str) -> None:
    try:
        response = client.get_public_key(KeyId=key_arn)
    except (BotoCoreError, ClientError):
        raise EngineError(502, "kms_key_unavailable") from None
    if (
        response.get("KeyId") != key_arn
        or response.get("KeyUsage") != "SIGN_VERIFY"
        or response.get("KeySpec") not in ("RSA_2048", "RSA_3072", "RSA_4096")
        or KMS_ALGORITHM not in (response.get("SigningAlgorithms") or [])
        or not hmac.compare_digest(
            bytes(response.get("PublicKey") or b""), identity.public_key_der
        )
    ):
        raise EngineError(409, "kms_key_certificate_mismatch")


# --------------------------------------------------------------------------- engine


class Engine:
    def __init__(
        self,
        identity: Identity,
        key_arn: str,
        client_factory: Callable[[], Any] | None = None,
        *,
        vercel: VercelConfig | None = None,
        transport: Transport = https_post,
    ) -> None:
        self.identity = identity
        self.vercel = vercel
        self.key_arn = vercel.key_id if vercel else key_arn
        self._transport = transport
        self._factory = (
            None if vercel else (client_factory or kms_client_factory(key_arn))
        )
        self._key_verified = False
        self._lock = threading.Lock()

    @property
    def requires_operation_id(self) -> bool:
        return self.vercel is not None

    def seal(
        self,
        source: bytes,
        source_sha256: str,
        certificate_sha256: str,
        operation_id: str | None = None,
    ) -> tuple[bytes, str]:
        # Exact input first, before any parsing or KMS use.
        if not hmac.compare_digest(
            hashlib.sha256(source).hexdigest().encode(), source_sha256.encode()
        ):
            raise EngineError(422, "source_digest_mismatch")
        if not hmac.compare_digest(
            self.identity.leaf_sha256.encode(), certificate_sha256.encode()
        ):
            raise EngineError(409, "signer_certificate_mismatch")
        self.identity.assert_valid(datetime.now(UTC))
        signer: OneShotSigner
        if self.vercel is not None:
            if operation_id is None or not UUID_V7.fullmatch(operation_id):
                raise EngineError(400, "bad_operation_id")
            signer = VercelSigner(
                self.identity, self.vercel, operation_id, self._transport
            )
        else:
            assert self._factory is not None
            client = self._factory()  # fresh client per accepted operation
            with self._lock:
                if not self._key_verified:
                    verify_kms_key(client, self.identity, self.key_arn)
                    self._key_verified = True
            signer = KmsSigner(self.identity, client, self.key_arn)
        metadata = signers.PdfSignatureMetadata(
            field_name=FIELD_NAME,
            md_algorithm="sha256",
            subfilter=SigSeedSubFilter.PADES,  # ETSI.CAdES.detached + signing-certificate-v2
            certify=False,  # approval signature, invisible, incremental update
        )
        output = io.BytesIO()
        try:
            writer = IncrementalPdfFileWriter(io.BytesIO(source))
            signers.sign_pdf(
                writer, signature_meta=metadata, signer=signer, output=output
            )
        except EngineError:
            raise
        except Exception:
            raise EngineError(
                422 if signer.sign_calls == 0 else 500,
                "pdf_rejected" if signer.sign_calls == 0 else "seal_failed",
                signer.kms_request_id,
            ) from None
        sealed = output.getvalue()
        if (
            signer.sign_calls != 1
            or signer.kms_request_id is None
            or len(sealed) <= len(source)
            or sealed[: len(source)] != source
        ):
            raise EngineError(500, "seal_output_rejected", signer.kms_request_id)
        return sealed, signer.kms_request_id


# --------------------------------------------------------------------------- HTTP


def _bad(code: str, status: int = 400) -> EngineError:
    return EngineError(status, code)


def _read_exact(rfile: Any, size: int) -> bytes:
    data = rfile.read(size)
    if len(data) != size:
        raise _bad("truncated_body")
    return data


def _read_chunked(rfile: Any, limit: int) -> bytes:
    out = bytearray()
    while True:
        line = rfile.readline(66)
        if not line.endswith(b"\r\n"):
            raise _bad("bad_chunk")
        size_text = line[:-2].split(b";", 1)[0]
        if not re.fullmatch(rb"[0-9a-fA-F]{1,8}", size_text):
            raise _bad("bad_chunk")
        size = int(size_text, 16)
        if size == 0:
            for _ in range(16):
                trailer = rfile.readline(1025)
                if trailer == b"\r\n":
                    return bytes(out)
                if not trailer.endswith(b"\r\n"):
                    break
            raise _bad("bad_chunk")
        if len(out) + size > limit:
            raise _bad("body_too_large", 413)
        out += _read_exact(rfile, size)
        if rfile.read(2) != b"\r\n":
            raise _bad("bad_chunk")


def read_body(headers: Any, rfile: Any, limit: int = MAX_BODY_BYTES) -> bytes:
    length = headers.get("Content-Length")
    encoding = headers.get("Transfer-Encoding")
    if length is not None and encoding is not None:
        raise _bad("ambiguous_framing")
    if encoding is not None:
        if encoding.strip().lower() != "chunked":
            raise _bad("unsupported_transfer_encoding")
        return _read_chunked(rfile, limit)
    if length is None:
        raise _bad("length_required", 411)
    if not re.fullmatch(r"[0-9]{1,10}", length):
        raise _bad("bad_content_length")
    if int(length) > limit:
        raise _bad("body_too_large", 413)
    return _read_exact(rfile, int(length))


def make_server(
    engine: Engine,
    token: str,
    host: str = "0.0.0.0",
    port: int = 8080,
    max_concurrent: int = 2,
) -> ThreadingHTTPServer:
    expected = hashlib.sha256(f"Bearer {token}".encode()).digest()
    slots = threading.BoundedSemaphore(max_concurrent)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "signkit-seal-engine"
        sys_version = ""
        timeout = 60

        def log_message(self, *_args: Any) -> None:  # no request logging
            return

        def _send(
            self,
            status: int,
            body: bytes,
            content_type: str,
            extra: dict[str, str] | None = None,
            close: bool = False,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        def _error(self, error: EngineError) -> None:
            extra = (
                {"x-signkit-kms-request-id": error.kms_request_id}
                if error.kms_request_id
                else None
            )
            body = json.dumps({"error": error.code}).encode()
            self._send(error.status, body, "application/json", extra, close=True)

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self._send(200, b'{"status":"ok"}', "application/json")
            else:
                self._error(_bad("not_found", 404))

        def do_POST(self) -> None:
            try:
                self._seal()
            except EngineError as error:
                self._error(error)
            except Exception:
                self._error(EngineError(500, "internal_error"))

        def _seal(self) -> None:
            if self.path != "/seal":
                raise _bad("not_found", 404)
            supplied = hashlib.sha256(
                (self.headers.get("Authorization") or "").encode()
            ).digest()
            if not hmac.compare_digest(supplied, expected):
                raise _bad("unauthorized", 401)
            if self.headers.get("X-SignKit-Seal-Profile") != PROFILE:
                raise _bad("unsupported_profile", 422)
            if self.headers.get("Content-Type") != "application/pdf":
                raise _bad("unsupported_media_type", 415)
            source_sha = self.headers.get("X-SignKit-Source-Sha256") or ""
            cert_sha = self.headers.get("X-SignKit-Signer-Certificate-Sha256") or ""
            if not HEX64.fullmatch(source_sha) or not HEX64.fullmatch(cert_sha):
                raise _bad("bad_digest_header")
            operation_id = None
            if engine.requires_operation_id:
                values = self.headers.get_all("x-signkit-operation-id") or []
                if len(values) != 1 or not UUID_V7.fullmatch(values[0]):
                    raise _bad("bad_operation_id")
                operation_id = values[0]
            if not slots.acquire(blocking=False):
                raise _bad("busy", 503)
            try:
                body = read_body(self.headers, self.rfile)
                sealed, kms_id = engine.seal(body, source_sha, cert_sha, operation_id)
            finally:
                slots.release()
            self._send(
                200,
                sealed,
                "application/pdf",
                {"x-signkit-kms-request-id": kms_id},
            )

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def main() -> None:
    env = os.environ
    token = env.get("ENGINE_TOKEN", "")
    key_arn = env.get("AWS_KMS_KEY_ARN", "")
    vercel_url = env.get("VERCEL_SIGNER_URL", "")
    if len(token) < 32:
        sys.exit("ENGINE_TOKEN must be at least 32 characters")
    try:
        identity = Identity.load(
            base64.b64decode(env.get("SEAL_CERTIFICATE_DER", ""), validate=True),
            base64.b64decode(env.get("SEAL_CA_DER", ""), validate=True),
        )
        if vercel_url:
            if key_arn:
                raise ValueError("AWS and Vercel signing modes are exclusive")
            engine = Engine(
                identity,
                "",
                vercel=VercelConfig.load(
                    vercel_url,
                    env.get("VERCEL_SIGNER_TOKEN", ""),
                    env.get("VERCEL_KMS_KEY_ID", ""),
                    env.get("VERCEL_KMS_FINGERPRINT", ""),
                ),
            )
        else:
            engine = Engine(identity, key_arn)
    except Exception:
        sys.exit("invalid seal certificate, CA chain or signing configuration")
    server = make_server(engine, token)
    signal.signal(
        signal.SIGTERM,
        lambda *_: threading.Thread(target=server.shutdown, daemon=True).start(),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
