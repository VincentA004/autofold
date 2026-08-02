from __future__ import annotations

from typing import Any, Protocol


class DesignAdapter(Protocol):
    def generate(self, bundle: dict[str, Any]) -> dict[str, Any]: ...

