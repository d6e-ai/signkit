#!/usr/bin/env python3
"""Generate ephemeral PAdES B-B/B-T fixtures without persisting private keys."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from asn1crypto import cms, core
from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.x509.oid import ExtendedKeyUsageOID, ExtensionOID, NameOID
from pyhanko.keys import load_cert_from_pemder, load_private_key_from_pemder
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import general, signers
from pyhanko.sign.fields import SigSeedSubFilter
from pyhanko.sign.general import simple_cms_attribute
from pyhanko.sign.timestamps import DummyTimeStamper
from pyhanko_certvalidator.util import get_pyca_cryptography_hash

VALIDATION_TIME = datetime(2026, 9, 23, tzinfo=UTC)
NOT_BEFORE = datetime(2025, 1, 1, tzinfo=UTC)
NOT_AFTER = datetime(2035, 1, 1, tzinfo=UTC)
BYTE_RANGE = re.compile(rb"/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]")
MARKER = b"SignKit PAdES conformance fixture"
EssMode = Literal["valid", "missing", "mismatch"]


class EssCertIdV2TimeStamper(DummyTimeStamper):
    """Test TSA that emits an explicit SHA-256 ESSCertIDv2 binding."""

    def __init__(self, *args: object, ess_mode: EssMode = "valid", **kwargs: object):
        super().__init__(*args, **kwargs)
        self.ess_mode: EssMode = ess_mode

    def _sign_tst_info(
        self, tst_info_data: bytes, md_algorithm: str, dt: datetime
    ) -> tuple[bytes, cms.CMSAttributes]:
        md_spec = get_pyca_cryptography_hash(md_algorithm)
        md = hashes.Hash(md_spec)
        md.update(tst_info_data)
        attributes = [
            simple_cms_attribute("content_type", "tst_info"),
            simple_cms_attribute(
                "signing_time", cms.Time({"utc_time": core.UTCTime(dt)})
            ),
        ]
        if self.ess_mode != "missing":
            signing_certificate = general.as_signing_certificate_v2(
                self.tsa_cert, hash_algo="sha256"
            )
            if self.ess_mode == "mismatch":
                signing_certificate["certs"][0]["cert_hash"] = b"\x00" * 32
            attributes.append(
                simple_cms_attribute("signing_certificate_v2", signing_certificate)
            )
        attributes.append(simple_cms_attribute("message_digest", md.finalize()))
        signed_attrs = cms.CMSAttributes(attributes)

        private_key = serialization.load_der_private_key(
            self.tsa_key.dump(), password=None
        )
        if not isinstance(private_key, RSAPrivateKey):
            raise NotImplementedError("test timestamper is RSA-only")
        signature = private_key.sign(
            signed_attrs.dump(),
            PKCS1v15(),
            get_pyca_cryptography_hash(md_algorithm.upper()),
        )
        return signature, signed_attrs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def build_source_pdf() -> bytes:
    stream = b"BT /F1 18 Tf 72 720 Td (SignKit PAdES conformance fixture) Tj ET\n"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length "
        + str(len(stream)).encode("ascii")
        + b" >>\nstream\n"
        + stream
        + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode("ascii"))
        pdf.extend(body)
        pdf.extend(b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(pdf)


def name(common_name: str) -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SignKit CI TEST ONLY"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )


def issue_certificates(
    private_dir: Path, trust_dir: Path
) -> tuple[
    Path,
    Path,
    Path,
    x509.Certificate,
    dict[str, x509.Certificate],
]:
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    signer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    tsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    root_subject = name("SignKit CI Root - NOT FOR PRODUCTION")
    root = (
        x509.CertificateBuilder()
        .subject_name(root_subject)
        .issuer_name(root_subject)
        .public_key(root_key.public_key())
        .serial_number(1)
        .not_valid_before(NOT_BEFORE)
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(root_key.public_key()),
            critical=False,
        )
        .sign(root_key, hashes.SHA256())
    )

    def leaf(
        common_name: str,
        public_key: rsa.RSAPublicKey,
        serial: int,
        *,
        eku_oids: tuple[x509.ObjectIdentifier, ...] = (),
        eku_critical: bool = True,
    ) -> x509.Certificate:
        builder = (
            x509.CertificateBuilder()
            .subject_name(name(common_name))
            .issuer_name(root.subject)
            .public_key(public_key)
            .serial_number(serial)
            .not_valid_before(NOT_BEFORE)
            .not_valid_after(NOT_AFTER)
            .add_extension(
                x509.BasicConstraints(ca=False, path_length=None), critical=True
            )
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=True,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=False,
                    crl_sign=False,
                    encipher_only=None,
                    decipher_only=None,
                ),
                critical=True,
            )
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False
            )
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(
                    root_key.public_key()
                ),
                critical=False,
            )
        )
        if eku_oids:
            builder = builder.add_extension(
                x509.ExtendedKeyUsage(list(eku_oids)),
                critical=eku_critical,
            )
        return builder.sign(root_key, hashes.SHA256())

    signer = leaf(
        "SignKit CI Instance Seal - NOT FOR PRODUCTION",
        signer_key.public_key(),
        2,
    )
    tsa_certificates = {
        "tsa": leaf(
            "SignKit CI TSA - NOT FOR PRODUCTION",
            tsa_key.public_key(),
            3,
            eku_oids=(ExtendedKeyUsageOID.TIME_STAMPING,),
        ),
        "tsa-eku-absent": leaf(
            "SignKit CI TSA missing EKU - INVALID",
            tsa_key.public_key(),
            4,
        ),
        "tsa-eku-noncritical": leaf(
            "SignKit CI TSA non-critical EKU - INVALID",
            tsa_key.public_key(),
            5,
            eku_oids=(ExtendedKeyUsageOID.TIME_STAMPING,),
            eku_critical=False,
        ),
        "tsa-eku-multipurpose": leaf(
            "SignKit CI TSA multi-purpose EKU - INVALID",
            tsa_key.public_key(),
            6,
            eku_oids=(
                ExtendedKeyUsageOID.TIME_STAMPING,
                ExtendedKeyUsageOID.CODE_SIGNING,
            ),
        ),
    }

    private_dir.mkdir(parents=True, exist_ok=True)
    trust_dir.mkdir(parents=True, exist_ok=True)
    root_path = private_dir / "root.pem"
    signer_path = trust_dir / "signer.pem"
    signer_key_path = private_dir / "signer-private.pem"
    tsa_key_path = private_dir / "tsa-private.pem"

    root_path.write_bytes(root.public_bytes(serialization.Encoding.PEM))
    signer_path.write_bytes(signer.public_bytes(serialization.Encoding.PEM))
    for certificate_name, certificate in tsa_certificates.items():
        (trust_dir / f"{certificate_name}.pem").write_bytes(
            certificate.public_bytes(serialization.Encoding.PEM)
        )
    signer_key_path.write_bytes(
        signer_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    tsa_key_path.write_bytes(
        tsa_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return signer_key_path, signer_path, tsa_key_path, signer, tsa_certificates


def sign_pdf(
    source_path: Path,
    output_path: Path,
    signer: signers.SimpleSigner,
    timestamper: DummyTimeStamper | None,
) -> None:
    metadata = signers.PdfSignatureMetadata(
        field_name="InstanceSeal",
        md_algorithm="sha256",
        subfilter=SigSeedSubFilter.PADES,
        certify=False,
        name="SignKit CI TEST ONLY",
        reason="PAdES conformance fixture",
    )
    with source_path.open("rb") as source, output_path.open("wb") as output:
        writer = IncrementalPdfFileWriter(source)
        signers.sign_pdf(
            writer,
            signature_meta=metadata,
            signer=signer,
            timestamper=timestamper,
            output=output,
        )


def timestamp_signed_attributes(
    embedded_signature: Any,
) -> cms.CMSAttributes | None:
    unsigned_attributes = embedded_signature.signer_info["unsigned_attrs"]
    if unsigned_attributes is None:
        return None
    timestamp_attributes = [
        attribute
        for attribute in unsigned_attributes
        if attribute["type"].native == "signature_time_stamp_token"
    ]
    if not timestamp_attributes:
        return None
    if len(timestamp_attributes) != 1:
        raise AssertionError("expected exactly one signature timestamp")
    timestamp_token = timestamp_attributes[0]["values"][0]
    timestamp_signers = timestamp_token["content"]["signer_infos"]
    if len(timestamp_signers) != 1:
        raise AssertionError("expected exactly one timestamp signer")
    return timestamp_signers[0]["signed_attrs"]


def timestamp_signer_certificate(
    embedded_signature: Any,
) -> asn1_x509.Certificate | None:
    unsigned_attributes = embedded_signature.signer_info["unsigned_attrs"]
    if unsigned_attributes is None:
        return None
    timestamp_attributes = [
        attribute
        for attribute in unsigned_attributes
        if attribute["type"].native == "signature_time_stamp_token"
    ]
    if not timestamp_attributes:
        return None
    timestamp_token = timestamp_attributes[0]["values"][0]
    signed_data = timestamp_token["content"]
    signer_info = signed_data["signer_infos"][0]
    signer_id = signer_info["sid"]
    if signer_id.name != "issuer_and_serial_number":
        raise AssertionError("timestamp signer must use issuer and serial number")
    expected_issuer = signer_id.chosen["issuer"]
    expected_serial = signer_id.chosen["serial_number"].native
    matches = [
        certificate.chosen
        for certificate in signed_data["certificates"]
        if certificate.name == "certificate"
        and certificate.chosen.issuer == expected_issuer
        and certificate.chosen.serial_number == expected_serial
    ]
    if len(matches) != 1:
        raise AssertionError("timestamp token must embed its exact signing certificate")
    return matches[0]


def assert_tsa_eku(tsa_certificate: asn1_x509.Certificate) -> None:
    certificate = x509.load_der_x509_certificate(tsa_certificate.dump())
    try:
        eku_extension = certificate.extensions.get_extension_for_oid(
            ExtensionOID.EXTENDED_KEY_USAGE
        )
    except x509.ExtensionNotFound as error:
        raise AssertionError("TSA certificate is missing Extended Key Usage") from error
    if not eku_extension.critical:
        raise AssertionError("TSA Extended Key Usage must be critical")
    if set(eku_extension.value) != {ExtendedKeyUsageOID.TIME_STAMPING}:
        raise AssertionError("TSA Extended Key Usage must contain only timeStamping")


def assert_pdf_timestamp_policy(pdf: bytes, *, timestamped: bool) -> None:
    reader = PdfFileReader(io.BytesIO(pdf))
    signatures = reader.embedded_regular_signatures
    if len(signatures) != 1:
        raise AssertionError("expected exactly one PDF signature")
    signature = signatures[0]
    signed_attributes = timestamp_signed_attributes(signature)
    tsa_certificate = timestamp_signer_certificate(signature)
    if timestamped:
        if signed_attributes is None or tsa_certificate is None:
            raise AssertionError("signature timestamp is missing")
        assert_tsa_eku(tsa_certificate)
        assert_ess_cert_id_v2(signed_attributes, tsa_certificate)
    elif signed_attributes is not None or tsa_certificate is not None:
        raise AssertionError("unexpected signature timestamp")


def assert_ess_cert_id_v2(
    signed_attributes: cms.CMSAttributes,
    expected_tsa_certificate: asn1_x509.Certificate,
) -> None:
    legacy_attributes = [
        attribute
        for attribute in signed_attributes
        if attribute["type"].native == "signing_certificate"
    ]
    if legacy_attributes:
        raise AssertionError("timestamp must not use legacy SHA-1 ESSCertID")
    v2_attributes = [
        attribute
        for attribute in signed_attributes
        if attribute["type"].native == "signing_certificate_v2"
    ]
    if len(v2_attributes) != 1:
        raise AssertionError("timestamp must contain exactly one SigningCertificateV2")
    cert_ids = v2_attributes[0]["values"][0]["certs"]
    if len(cert_ids) != 1:
        raise AssertionError("timestamp must contain exactly one ESSCertIDv2")
    cert_id = cert_ids[0]
    algorithm = cert_id["hash_algorithm"]["algorithm"].native
    if algorithm != "sha256":
        raise AssertionError("timestamp ESSCertIDv2 must use SHA-256")
    expected_hash = hashlib.sha256(expected_tsa_certificate.dump()).digest()
    if cert_id["cert_hash"].native != expected_hash:
        raise AssertionError("timestamp ESSCertIDv2 certificate hash does not match")
    issuer_serial = cert_id["issuer_serial"]
    if issuer_serial["serial_number"].native != expected_tsa_certificate.serial_number:
        raise AssertionError("timestamp ESSCertIDv2 serial number does not match")
    issuer_names = issuer_serial["issuer"]
    if (
        len(issuer_names) != 1
        or issuer_names[0].chosen != expected_tsa_certificate.issuer
    ):
        raise AssertionError("timestamp ESSCertIDv2 issuer does not match")


def assert_signed_structure(
    source: bytes,
    signed: bytes,
    *,
    timestamped: bool,
    expected_tsa_certificate: asn1_x509.Certificate | None = None,
) -> None:
    if not signed.startswith(source):
        raise AssertionError("signed PDF does not preserve the exact source prefix")
    if b"/SubFilter /ETSI.CAdES.detached" not in signed:
        raise AssertionError("signature is not ETSI.CAdES.detached")
    if b"/DocMDP" in signed:
        raise AssertionError(
            "fixture unexpectedly contains a DocMDP certification signature"
        )
    matches = list(BYTE_RANGE.finditer(signed))
    if len(matches) != 1:
        raise AssertionError(f"expected one ByteRange, found {len(matches)}")
    first, first_length, second, second_length = (
        int(value) for value in matches[0].groups()
    )
    if first != 0 or first_length <= 0 or second <= first_length:
        raise AssertionError("invalid ByteRange layout")
    if second + second_length != len(signed):
        raise AssertionError("ByteRange does not cover the complete signed revision")
    excluded = signed[first_length:second]
    if not (excluded.startswith(b"<") and excluded.endswith(b">")):
        raise AssertionError(
            "ByteRange exclusion is not exactly the Contents hex string"
        )
    reader = PdfFileReader(io.BytesIO(signed))
    embedded_signatures = reader.embedded_regular_signatures
    if len(embedded_signatures) != 1:
        raise AssertionError(
            f"expected one embedded signature, found {len(embedded_signatures)}"
        )
    embedded_signature = embedded_signatures[0]
    if embedded_signature.field_name != "InstanceSeal":
        raise AssertionError("unexpected signature field name")
    rectangle = embedded_signature.sig_field.get("/Rect")
    if rectangle is None or tuple(float(value) for value in rectangle) != (
        0.0,
        0.0,
        0.0,
        0.0,
    ):
        raise AssertionError("signature field is not invisible")
    signed_attributes = timestamp_signed_attributes(embedded_signature)
    has_timestamp = signed_attributes is not None
    if has_timestamp != timestamped:
        raise AssertionError(
            "signature timestamp presence does not match the requested profile"
        )
    if expected_tsa_certificate is not None:
        if signed_attributes is None:
            raise AssertionError("timestamp signed attributes are missing")
        assert_ess_cert_id_v2(signed_attributes, expected_tsa_certificate)


def tamper_signed_source(source: bytes, signed: bytes) -> bytes:
    marker_offset = source.find(MARKER)
    if marker_offset < 0:
        raise AssertionError("source marker is missing")
    tampered = bytearray(signed)
    tampered[marker_offset] = ord("T")
    return bytes(tampered)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    args = parse_args()
    output_dir: Path = args.out.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    reports_dir = output_dir / "reports"
    reports_dir.mkdir(exist_ok=True)
    trust_dir = output_dir / "trust"

    source_path = output_dir / "source.pdf"
    source = build_source_pdf()
    source_path.write_bytes(source)

    with tempfile.TemporaryDirectory(prefix="signkit-pades-private-") as private_name:
        private_dir = Path(private_name)
        signer_key_path, signer_path, tsa_key_path, signer_cert, tsa_certificates = (
            issue_certificates(private_dir, trust_dir)
        )
        root_path = private_dir / "root.pem"
        signer = signers.SimpleSigner.load(
            key_file=str(signer_key_path),
            cert_file=str(signer_path),
            ca_chain_files=(str(root_path),),
            key_passphrase=None,
        )
        if signer is None:
            raise AssertionError("pyHanko failed to load the fixture signer")
        tsa_key = load_private_key_from_pemder(str(tsa_key_path), passphrase=None)
        tsa_cert = load_cert_from_pemder(str(trust_dir / "tsa.pem"))
        timestamper = EssCertIdV2TimeStamper(
            tsa_cert=tsa_cert,
            tsa_key=tsa_key,
            certs_to_embed=None,
            fixed_dt=VALIDATION_TIME,
            include_nonce=True,
        )
        negative_timestampers = {
            "ess-missing": EssCertIdV2TimeStamper(
                tsa_cert=tsa_cert,
                tsa_key=tsa_key,
                certs_to_embed=None,
                fixed_dt=VALIDATION_TIME,
                include_nonce=True,
                ess_mode="missing",
            ),
            "ess-mismatch": EssCertIdV2TimeStamper(
                tsa_cert=tsa_cert,
                tsa_key=tsa_key,
                certs_to_embed=None,
                fixed_dt=VALIDATION_TIME,
                include_nonce=True,
                ess_mode="mismatch",
            ),
        }
        for variant in (
            "tsa-eku-absent",
            "tsa-eku-noncritical",
            "tsa-eku-multipurpose",
        ):
            negative_timestampers[variant] = EssCertIdV2TimeStamper(
                tsa_cert=load_cert_from_pemder(str(trust_dir / f"{variant}.pem")),
                tsa_key=tsa_key,
                certs_to_embed=None,
                fixed_dt=VALIDATION_TIME,
                include_nonce=True,
            )

        bb_path = output_dir / "pades-b-b.pdf"
        bt_path = output_dir / "pades-b-t.pdf"
        sign_pdf(source_path, bb_path, signer, None)
        sign_pdf(source_path, bt_path, signer, timestamper)
        for variant, invalid_timestamper in negative_timestampers.items():
            sign_pdf(
                source_path,
                output_dir / f"invalid-{variant}.pdf",
                signer,
                invalid_timestamper,
            )

        bb = bb_path.read_bytes()
        bt = bt_path.read_bytes()
        assert_signed_structure(source, bb, timestamped=False)
        assert_signed_structure(
            source,
            bt,
            timestamped=True,
            expected_tsa_certificate=tsa_cert,
        )
        (output_dir / "tampered-b-b.pdf").write_bytes(tamper_signed_source(source, bb))
        (output_dir / "tampered-b-t.pdf").write_bytes(tamper_signed_source(source, bt))

    files = sorted(
        path
        for path in output_dir.rglob("*")
        if path.is_file() and path.name not in {"SHA256SUMS", "manifest.json"}
    )
    manifest = {
        "schema": "signkit-pades-conformance-v1",
        "validationTime": VALIDATION_TIME.isoformat().replace("+00:00", "Z"),
        "tools": {
            "cryptography": importlib.metadata.version("cryptography"),
            "pyhanko": importlib.metadata.version("pyhanko"),
            "pyhanko-cli": importlib.metadata.version("pyhanko-cli"),
        },
        "certificates": {
            "signerSha256": signer_cert.fingerprint(hashes.SHA256()).hex(),
            "tsaSha256": tsa_certificates["tsa"].fingerprint(hashes.SHA256()).hex(),
        },
        "files": {
            str(path.relative_to(output_dir)): {
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in files
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    checksum_paths = [*files, output_dir / "manifest.json"]
    (output_dir / "SHA256SUMS").write_text(
        "".join(
            f"{sha256(path)}  {path.relative_to(output_dir)}\n"
            for path in checksum_paths
        ),
        encoding="utf-8",
    )

    forbidden = [
        path
        for path in output_dir.rglob("*")
        if path.is_file()
        and (
            path.suffix.lower() in {".key", ".p12", ".pfx", ".pkcs12"}
            or b"PRIVATE KEY" in path.read_bytes()
        )
    ]
    if forbidden:
        raise AssertionError(
            f"private key material escaped into the artifact directory: {forbidden}"
        )


if __name__ == "__main__":
    main()
