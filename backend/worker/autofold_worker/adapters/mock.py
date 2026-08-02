from __future__ import annotations

from typing import Any

from ..design import generate


class MockDesignAdapter:
    def generate(self, bundle: dict[str, Any]) -> dict[str, Any]:
        return generate(bundle)

