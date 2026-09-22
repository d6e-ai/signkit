#!/usr/bin/env python3
"""Run pyHanko with every AdES wall-clock fallback fixed to the fixture time."""

from __future__ import annotations

import sys
from contextlib import ExitStack
from datetime import UTC, datetime, tzinfo
from pathlib import Path
from unittest.mock import patch

from generate import assert_pdf_timestamp_policy
from pyhanko.cli import launch

VALIDATION_TIME = datetime(2026, 9, 23, tzinfo=UTC)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz: tzinfo | None = None) -> FrozenDateTime:
        value = VALIDATION_TIME if tz is None else VALIDATION_TIME.astimezone(tz)
        return cls.fromtimestamp(value.timestamp(), tz=value.tzinfo)

    @classmethod
    def utcnow(cls) -> FrozenDateTime:
        return cls.fromtimestamp(VALIDATION_TIME.timestamp(), tz=UTC).replace(
            tzinfo=None
        )


def main() -> None:
    try:
        expectation_index = sys.argv.index("--signkit-expect")
        expectation = sys.argv[expectation_index + 1]
    except (ValueError, IndexError) as error:
        raise SystemExit(
            "--signkit-expect must name a valid or rejected fixture class"
        ) from error
    if expectation not in {
        "valid-b-b",
        "valid-b-t",
        "rejected-b-b",
        "rejected-b-t",
        "rejected-policy",
    }:
        raise SystemExit("unsupported --signkit-expect value")
    del sys.argv[expectation_index : expectation_index + 2]
    input_path = Path(sys.argv[-1])
    timestamp_expected = expectation in {
        "valid-b-t",
        "rejected-b-t",
        "rejected-policy",
    }
    try:
        assert_pdf_timestamp_policy(
            input_path.read_bytes(), timestamped=timestamp_expected
        )
    except AssertionError as error:
        if expectation == "rejected-policy":
            raise SystemExit(f"PAdES policy rejected {input_path}: {error}") from error
        raise

    datetime_targets = (
        "pyhanko.sign.validation.ades.datetime",
        "pyhanko_certvalidator.ltv.ades_past.datetime",
        "pyhanko_certvalidator.ltv.poe.datetime",
        "pyhanko_certvalidator.ltv.types.datetime",
    )
    with ExitStack() as stack:
        for target in datetime_targets:
            stack.enter_context(patch(target, FrozenDateTime))
        launch()


if __name__ == "__main__":
    main()
