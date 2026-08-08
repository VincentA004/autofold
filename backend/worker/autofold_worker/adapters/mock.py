from __future__ import annotations

from pathlib import Path
from typing import Any

from ..design import generate


class MockDesignAdapter:
    def generate(self, bundle: dict[str, Any], output: Path) -> dict[str, Any]:  # noqa: ARG002
        return generate(bundle)
