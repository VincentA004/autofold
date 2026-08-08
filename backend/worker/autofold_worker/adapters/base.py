from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol


class DesignAdapter(Protocol):
    def generate(self, bundle: dict[str, Any], output: Path) -> dict[str, Any]: ...
