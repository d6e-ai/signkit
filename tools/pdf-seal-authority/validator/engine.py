"""PAdES B-B validation engine.

Every reported check is computed from the document; a flag is never defaulted to true.
Any unexpected parser/library failure inside a stage fails that stage closed. No network
access is possible: the validation context disables fetching and trusts only the pinned CA.
"""

from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from config import Config

FAILURE_ORDER: tuple[str, ...] = (
    "source_prefix_mismatch",
    "incremental_update_invalid",
    "byte_range_invalid",
    "cms_signature_invalid",
    "cms_profile_invalid",
    "signer_certificate_unprotected",
    "signer_certificate_mismatch",
    "certificate_path_invalid",
    "seal_policy_rejected",
    "approval_signature_invalid",
    "doc_mdp_forbidden",
    "post_seal_changes_detected",
    "unsupported_algorithm",
)
CHECK_KEYS: tuple[str, ...] = (
    "sourcePrefixExact",
    "incrementalUpdateValid",
    "byteRangeComplete",
    "cmsSignatureValid",
    "cmsProfileValid",
    "signerCertificateProtected",
    "signerCertificateDigestMatches",
    "certificatePathValid",
    "sealPolicyValid",
    "invisibleApprovalSignature",
    "docMdpAbsent",
    "noPostSealChanges",
)
ALLOWED_DIGESTS = {"sha256", "sha384", "sha512"}
HEX_CONTENTS = re.compile(rb"^<[0-9A-Fa-f]*>$")
ROOT_MUTABLE = {"/AcroForm", "/Extensions"}
OTHER_MUTABLE = {"/Annots", "/Fields", "/SigFlags"}
ACROFORM_ALLOWED = {"/Fields", "/SigFlags"}


@dataclass
class Reference:
    seal_policy_id: str
    validation_policy_id: str
    signer_certificate_sha256: str


@dataclass
class Outcome:
    checks: dict[str, bool] = field(default_factory=lambda: {key: False for key in CHECK_KEYS})
    failures: set[str] = field(default_factory=set)

    def fail(self, code: str) -> None:
        self.failures.add(code)

    @property
    def valid(self) -> bool:
        return not self.failures and all(self.checks.values())

    def ordered_failures(self) -> list[str]:
        codes = [code for code in FAILURE_ORDER if code in self.failures]
        # A rejected document with no specific code must still be reported as invalid.
        return codes or ["cms_profile_invalid"]


def evaluate(
    config: Config, reference: Reference, source: bytes, sealed: bytes, now: datetime | None = None
) -> Outcome:
    outcome = Outcome()
    now = now or datetime.now(UTC)

    if len(sealed) > len(source) and memoryview(sealed)[: len(source)] == memoryview(source):
        outcome.checks["sourcePrefixExact"] = True
    else:
        outcome.fail("source_prefix_mismatch")
        return outcome

    outcome.checks["sealPolicyValid"] = (
        reference.seal_policy_id == config.seal_policy_id
        and reference.validation_policy_id == config.validation_policy_id
    )
    if not outcome.checks["sealPolicyValid"]:
        outcome.fail("seal_policy_rejected")

    try:
        source_reader = PdfFileReader(io.BytesIO(source))
        sealed_reader = PdfFileReader(io.BytesIO(sealed))
        signatures = list(sealed_reader.embedded_signatures)
        source_revisions = source_reader.xrefs.total_revisions
        sealed_revisions = sealed_reader.xrefs.total_revisions
        source_has_signature = bool(list(source_reader.embedded_signatures))
    except Exception:
        outcome.fail("incremental_update_invalid")
        return outcome

    suffix = sealed[len(source) :]
    structural = (
        not source_has_signature
        and sealed_revisions == source_revisions + 1
        and len(signatures) == 1
        and suffix.rstrip(b" \t\r\n").endswith(b"%%EOF")
        and suffix.count(b"startxref") == 1
    )
    if structural:
        try:
            structural = _revision_changes_allowed(source_reader, sealed_reader, source_revisions)
        except Exception:
            structural = False
    outcome.checks["incrementalUpdateValid"] = structural
    if not structural:
        outcome.fail("incremental_update_invalid")
    if len(signatures) != 1:
        outcome.fail("byte_range_invalid")
        return outcome
    signature = signatures[0]

    _check_byte_range(outcome, sealed, len(source), signature)
    _check_doc_mdp_and_approval(outcome, sealed, suffix, sealed_reader, signature)
    _check_cms_profile(outcome, config, reference, signature)
    _check_cryptography(outcome, config, signature, now)
    return outcome


def _revision_changes_allowed(
    source_reader: PdfFileReader, sealed_reader: PdfFileReader, source_revisions: int
) -> bool:
    """The single new revision may only add the signature field/value and wire it in."""
    old = sealed_reader.get_historical_resolver(source_revisions - 1)
    new = sealed_reader.get_historical_resolver(source_revisions)
    if list(new.refs_freed_in_revision()):
        return False
    source_size = int(source_reader.trailer["/Size"])
    root_id = source_reader.root_ref.idnum
    for ref in new.explicit_refs_in_revision():
        if ref.idnum >= source_size:
            continue  # brand-new object
        old_obj = old.get_object(ref)
        new_obj = new.get_object(ref)
        if hasattr(old_obj, "encoded_data") or hasattr(new_obj, "encoded_data"):
            return False  # no existing stream (page content, fonts, images) may change
        if not isinstance(old_obj, dict) or not isinstance(new_obj, dict):
            return False
        mutable = ROOT_MUTABLE if ref.idnum == root_id else OTHER_MUTABLE
        old_items = dict(dict.items(old_obj))
        new_items = dict(dict.items(new_obj))
        for key in set(old_items) | set(new_items):
            if key in mutable:
                continue
            if key not in old_items or key not in new_items:
                return False
            if _canonical(old_items[key]) != _canonical(new_items[key]):
                return False
        if ref.idnum == root_id and not _acroform_extends(old_items, new_items):
            return False
        if "/Fields" in new_items or "/Fields" in old_items:
            if not _adds_exactly_one(old_items.get("/Fields"), new_items.get("/Fields")):
                return False
        if "/Annots" in new_items or "/Annots" in old_items:
            if not _adds_exactly_one(old_items.get("/Annots"), new_items.get("/Annots")):
                return False
    return True


def _acroform_extends(old_items: dict[Any, Any], new_items: dict[Any, Any]) -> bool:
    if "/AcroForm" not in new_items:
        return False
    new_form = new_items["/AcroForm"]
    new_form = new_form.get_object() if hasattr(new_form, "idnum") else new_form
    if not isinstance(new_form, dict) or not set(dict.keys(new_form)) <= ACROFORM_ALLOWED:
        # Fields not in the allowlist (e.g. JavaScript actions) are not introduced by the seal.
        old_form = old_items.get("/AcroForm")
        if old_form is None:
            return False
        old_form = old_form.get_object() if hasattr(old_form, "idnum") else old_form
        extra = set(dict.keys(new_form)) - ACROFORM_ALLOWED
        return all(
            key in dict.keys(old_form)
            and _canonical(dict.get(old_form, key)) == _canonical(dict.get(new_form, key))
            for key in extra
        )
    return True


def _adds_exactly_one(old_array: Any, new_array: Any) -> bool:
    old_set = _raw_items(old_array)
    new_items = _raw_items(new_array)
    if old_set is None and new_items is None:
        return True
    old_items = old_set or []
    if new_items is None:
        return False
    return len(new_items) == len(old_items) + 1 and all(item in new_items for item in old_items)


def _raw_items(value: Any) -> list[Any] | None:
    if value is None:
        return None
    if hasattr(value, "idnum"):
        value = value.get_object()
    if not isinstance(value, list):
        return None
    return [_canonical(item) for item in list.__iter__(value)]


def _canonical(value: Any) -> Any:
    if hasattr(value, "idnum") and hasattr(value, "generation"):
        return ("ref", int(value.idnum), int(value.generation))
    if isinstance(value, dict):
        return (
            "dict",
            tuple(sorted((str(key), _canonical(item)) for key, item in dict.items(value))),
        )
    if isinstance(value, list):
        return ("list", tuple(_canonical(item) for item in list.__iter__(value)))
    if isinstance(value, (bytes, bytearray)):
        return ("bytes", bytes(value))
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return ("num", float(value))
    if isinstance(value, str):
        return ("str", str(value))
    return ("other", repr(value))


def _check_byte_range(outcome: Outcome, sealed: bytes, source_length: int, signature: Any) -> None:
    ok = False
    try:
        byte_range = [int(item) for item in signature.sig_object["/ByteRange"]]
        if len(byte_range) == 4:
            first_start, first_length, second_start, second_length = byte_range
            gap = sealed[first_length:second_start]
            ok = (
                first_start == 0
                and first_length > source_length
                and second_start > first_length
                and second_length > 0
                and second_start + second_length == len(sealed)
                and sealed.count(b"/ByteRange") == 1
                and HEX_CONTENTS.fullmatch(gap) is not None
            )
    except Exception:
        ok = False
    outcome.checks["byteRangeComplete"] = ok
    if not ok:
        outcome.fail("byte_range_invalid")
        # Bytes after the signed revision are the characteristic way this check fails.
        outcome.fail("post_seal_changes_detected")


def _check_doc_mdp_and_approval(
    outcome: Outcome, sealed: bytes, suffix: bytes, sealed_reader: PdfFileReader, signature: Any
) -> None:
    doc_mdp_absent = False
    try:
        signature_dict = signature.sig_object
        catalog = sealed_reader.root
        doc_mdp_absent = (
            b"/DocMDP" not in sealed
            and b"/Perms" not in suffix
            and "/Perms" not in catalog
            and "/Reference" not in signature_dict
        )
    except Exception:
        doc_mdp_absent = False
    outcome.checks["docMdpAbsent"] = doc_mdp_absent
    if not doc_mdp_absent:
        outcome.fail("doc_mdp_forbidden")

    approval = False
    try:
        field_dict = signature.sig_field
        rectangle = [float(value) for value in field_dict["/Rect"]]
        sub_filter = str(signature.sig_object.get("/SubFilter"))
        approval = (
            str(field_dict.get("/FT")) == "/Sig"
            and rectangle == [0.0, 0.0, 0.0, 0.0]
            and sub_filter == "/ETSI.CAdES.detached"
            and str(signature.sig_object.get("/Type", "/Sig")) == "/Sig"
        )
    except Exception:
        approval = False
    outcome.checks["invisibleApprovalSignature"] = approval
    if not approval:
        outcome.fail("approval_signature_invalid")


def _check_cms_profile(
    outcome: Outcome, config: Config, reference: Reference, signature: Any
) -> None:
    profile_ok = False
    protected = False
    digest_matches = False
    try:
        signed_data = signature.signed_data
        signer_infos = signed_data["signer_infos"]
        signer_info = signature.signer_info
        certificate = signature.signer_cert
        certificate_der = certificate.dump()
        certificate_sha256 = hashlib.sha256(certificate_der).hexdigest()

        digest_algorithm = signer_info["digest_algorithm"]["algorithm"].native
        if digest_algorithm not in ALLOWED_DIGESTS:
            outcome.fail("unsupported_algorithm")
        detached = signed_data["encap_content_info"]["content"].native is None
        signed_attrs = signer_info["signed_attrs"]
        attrs = [] if signed_attrs.native is None else list(signed_attrs)
        types = [attribute["type"].native for attribute in attrs]
        no_unsigned = signer_info["unsigned_attrs"].native is None
        profile_ok = (
            len(signer_infos) == 1
            and detached
            and digest_algorithm in ALLOWED_DIGESTS
            and types.count("content_type") == 1
            and types.count("message_digest") == 1
            and types.count("signing_certificate_v2") == 1
            and "signing_certificate" not in types
            and no_unsigned  # B-B only: signature timestamp and every unsigned attribute rejected
            and signer_info["sid"].name == "issuer_and_serial_number"
        )
        if profile_ok:
            protected = _ess_binding_matches(attrs, certificate)
        digest_matches = (
            certificate_sha256 == config.signer_certificate_sha256
            and certificate_sha256 == reference.signer_certificate_sha256
        )
    except Exception:
        profile_ok = False
    outcome.checks["cmsProfileValid"] = profile_ok
    outcome.checks["signerCertificateProtected"] = protected
    outcome.checks["signerCertificateDigestMatches"] = digest_matches
    if not profile_ok:
        outcome.fail("cms_profile_invalid")
    elif not protected:
        outcome.fail("signer_certificate_unprotected")
    if not digest_matches:
        outcome.fail("signer_certificate_mismatch")


def _ess_binding_matches(attrs: list[Any], certificate: Any) -> bool:
    attribute = next(item for item in attrs if item["type"].native == "signing_certificate_v2")
    cert_ids = attribute["values"][0]["certs"]
    if len(cert_ids) != 1:
        return False
    cert_id = cert_ids[0]
    algorithm = cert_id["hash_algorithm"]["algorithm"].native
    if algorithm not in ALLOWED_DIGESTS:
        return False
    expected = hashlib.new(algorithm, certificate.dump()).digest()
    if cert_id["cert_hash"].native != expected:
        return False
    issuer_serial = cert_id["issuer_serial"]
    if issuer_serial.native is not None:
        names = issuer_serial["issuer"]
        if (
            issuer_serial["serial_number"].native != certificate.serial_number
            or len(names) != 1
            or names[0].chosen != certificate.issuer
        ):
            return False
    return True


def _check_cryptography(outcome: Outcome, config: Config, signature: Any, now: datetime) -> None:
    signature_valid = False
    path_valid = False
    unchanged = False
    try:
        context = ValidationContext(
            trust_roots=[config.ca_certificate],
            allow_fetching=False,
            revocation_mode="soft-fail",
            moment=now,
        )
        status = validate_pdf_signature(signature, signer_validation_context=context)
        signature_valid = bool(status.intact and status.valid)
        path_valid = bool(status.trusted)
        modification = getattr(status.modification_level, "name", None)
        unchanged = (
            getattr(status.coverage, "name", None) == "ENTIRE_FILE"
            and modification in (None, "NONE")
        )
    except Exception:
        pass
    outcome.checks["cmsSignatureValid"] = signature_valid
    outcome.checks["certificatePathValid"] = path_valid
    outcome.checks["noPostSealChanges"] = unchanged and outcome.checks["byteRangeComplete"]
    if not signature_valid:
        outcome.fail("cms_signature_invalid")
    if not path_valid:
        outcome.fail("certificate_path_invalid")
    if not outcome.checks["noPostSealChanges"]:
        outcome.fail("post_seal_changes_detected")
