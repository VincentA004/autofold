"""Compatibility tests for the trusted Boltz-2 evidence adapter."""

from __future__ import annotations

import unittest

from autofold_worker.evidence_boltz2_v1 import _structure_cif


class StructureCifCompatibilityTest(unittest.TestCase):
    def test_reads_current_string_property(self) -> None:
        class CurrentStructure:
            structure_cif = "data_current\n#\n"

        self.assertEqual(_structure_cif(CurrentStructure()), "data_current\n#\n")

    def test_reads_legacy_callable(self) -> None:
        class LegacyStructure:
            def structure_cif(self) -> str:
                return "data_legacy\n#\n"

        self.assertEqual(_structure_cif(LegacyStructure()), "data_legacy\n#\n")


if __name__ == "__main__":
    unittest.main()
