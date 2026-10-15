"""Optional Proto generator plugins for independently installed design CLIs."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Literal

from proto_language.core import Generator, GeneratorInputType
from proto_language.generator.generator_registry import generator
from proto_language.utils.base import BaseConfig, ConfigField
from proto_tools.entities.structures import Structure

from .generator_spec import materialize_design_spec, run_generator_command, validate_materialized_spec


def _structure(value: Structure | str) -> Structure:
    return value if isinstance(value, Structure) else Structure(structure=value)


def _designs(root: Path, target_chains: set[str], expected: int, binder_length: int) -> list[tuple[Structure, str]]:
    designs: list[tuple[Structure, str]] = []
    preferred = [
        *root.glob("**/refold_cif/*.cif"),
        *root.glob("**/orig_designed/*.cif"),
        *root.glob("**/intermediate_designs_inverse_folded/*.cif"),
        *root.glob("**/predictions/**/*.cif"),
        *root.glob("**/*.cif"),
    ]
    seen: set[Path] = set()
    for path in preferred:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        try:
            structure = Structure(structure=path.read_text(encoding="utf-8"))
            sequences = structure.get_chain_sequences(remove_non_standard=True)
        except (OSError, ValueError):
            continue
        exact_length = [chain for chain, sequence in sequences.items() if len(sequence) == binder_length]
        binder_chains = exact_length or [
            chain for chain, sequence in sequences.items() if chain not in target_chains and sequence
        ]
        if not binder_chains:
            continue
        binder = binder_chains[-1]
        designs.append((structure, sequences[binder]))
        if len(designs) == expected:
            break
    return designs


class BoltzGenBinderConfig(BaseConfig):
    target_structure: Structure | str = ConfigField(title="Target Structure", description="Frozen target structure")
    target_chain: str = ConfigField(default="A", title="Target Chain", description="Target protein chain ID")
    hotspots: list[int] = ConfigField(default_factory=list, title="Target Hotspots", description="Target residue positions")
    executable: str = ConfigField(
        default_factory=lambda: os.environ.get("AUTOFOLD_BOLTZGEN_EXECUTABLE", "boltzgen"),
        title="BoltzGen Executable",
        description="Pinned BoltzGen CLI path supplied by the execution plane",
    )
    cache_dir: str = ConfigField(
        default_factory=lambda: os.environ.get("AUTOFOLD_BOLTZGEN_CACHE", ""),
        title="BoltzGen Cache",
        description="Pinned BoltzGen model cache supplied by the execution plane",
    )
    protocol: Literal["peptide-anything", "protein-anything"] = ConfigField(
        default="peptide-anything", title="Protocol", description="BoltzGen protocol preset"
    )
    scaffold: Literal["linear", "cyclic", "disulfide_beta_hairpin"] = ConfigField(
        default="linear",
        title="Peptide Scaffold",
        description="Native BoltzGen peptide topology and secondary-structure conditioning",
    )


@generator(
    key="boltzgen-binder",
    label="BoltzGen Binder Design",
    config=BoltzGenBinderConfig,
    description="All-atom BoltzGen peptide/protein binder generation",
    uses_gpu=True,
    # This adapter invokes its own CLI, not a registered proto_tools request.
    tools_called=[],
    supported_sequence_types=["protein"],
)
class BoltzGenBinderGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config: BoltzGenBinderConfig) -> None:
        super().__init__()
        self.config = config

    def _preserve_structure_after_sample(self) -> bool:
        return True

    def _sample(self) -> None:
        if not self.config.cache_dir:
            raise ValueError("BoltzGen requires AUTOFOLD_BOLTZGEN_CACHE in the execution profile")
        segment = self.segment
        target = _structure(self.config.target_structure)
        seed = self._next_seed()
        with tempfile.TemporaryDirectory(prefix="autofold-boltzgen-") as temporary:
            root = Path(temporary)
            target_path = root / "target.pdb"
            target.write_pdb(target_path)
            spec_path = materialize_design_spec(
                "boltzgen-binder", self.config, segment.sequence_length, root,
                target_path.read_text(encoding="utf-8"),
            )
            validate_materialized_spec("boltzgen-binder", spec_path)
            output = root / "output"
            command = [
                self.config.executable,
                "run",
                str(spec_path),
                "--output",
                str(output),
                "--protocol",
                self.config.protocol,
                "--num_designs",
                str(segment.num_proposals),
                "--budget",
                str(segment.num_proposals),
                "--diffusion_batch_size",
                "1",
                "--cache",
                self.config.cache_dir,
            ]
            run_generator_command(command, timeout=getattr(self, "_autofold_timeout", None))
            designs = _designs(output, {self.config.target_chain}, segment.num_proposals, segment.sequence_length)
            if not designs:
                raise RuntimeError("BoltzGen produced no parseable binder designs")
            segment.proposal_sequences = segment.proposal_sequences[: len(designs)]
            for proposal, (structure, sequence) in zip(segment.proposal_sequences, designs, strict=True):
                proposal.sequence = sequence
                proposal.structure = structure
                proposal._generator_metadata[self._spec.key] = {
                    "seed": seed,
                    "seedControl": "upstream_cli_unavailable",
                    "protocol": self.config.protocol,
                    "scaffold": self.config.scaffold,
                }


class PXDesignBinderConfig(BaseConfig):
    target_structure: Structure | str = ConfigField(title="Target Structure", description="Frozen target structure")
    target_chains: list[str] = ConfigField(default_factory=lambda: ["A"], title="Target Chains", description="Target protein chain IDs")
    hotspots: list[int] = ConfigField(default_factory=list, title="Target Hotspots", description="Target residue positions")
    executable: str = ConfigField(
        default_factory=lambda: os.environ.get("AUTOFOLD_PXDESIGN_EXECUTABLE", "pxdesign"),
        title="PXDesign Executable",
        description="Pinned PXDesign CLI path supplied by the execution plane",
    )
    preset: Literal["preview", "extended"] = ConfigField(
        default="preview", title="Pipeline Preset", description="PXDesign sequence-design and validation preset"
    )
    diffusion_steps: int = ConfigField(default=400, ge=1, title="Diffusion Steps", description="PXDesign diffusion step count")
    dtype: Literal["bf16", "fp32"] = ConfigField(default="bf16", title="Dtype", description="PXDesign inference precision")


@generator(
    key="pxdesign-binder",
    label="PXDesign Binder Design",
    config=PXDesignBinderConfig,
    description="PXDesign diffusion binder generation",
    uses_gpu=True,
    # Host path/spec preflight and generator sampling/wall limits own this CLI.
    tools_called=[],
    supported_sequence_types=["protein"],
)
class PXDesignBinderGenerator(Generator):
    input_type = GeneratorInputType.STARTING_SEQUENCE
    allows_empty_starting_sequence = True

    def __init__(self, config: PXDesignBinderConfig) -> None:
        super().__init__()
        self.config = config

    def _preserve_structure_after_sample(self) -> bool:
        return True

    def _sample(self) -> None:
        segment = self.segment
        target = _structure(self.config.target_structure)
        seed = self._next_seed()
        with tempfile.TemporaryDirectory(prefix="autofold-pxdesign-") as temporary:
            root = Path(temporary)
            target_path = root / "target.pdb"
            target.write_pdb(target_path)
            spec_path = materialize_design_spec(
                "pxdesign-binder", self.config, segment.sequence_length, root,
                target_path.read_text(encoding="utf-8"),
            )
            validate_materialized_spec("pxdesign-binder", spec_path)
            output = root / "output"
            command = [
                self.config.executable,
                "pipeline",
                "--preset",
                self.config.preset,
                "-i",
                str(spec_path),
                "-o",
                str(output),
                "--N_sample",
                str(segment.num_proposals),
                "--N_step",
                str(self.config.diffusion_steps),
                "--N_max_runs",
                "1",
                "--dtype",
                self.config.dtype,
            ]
            if seed is not None:
                command.extend(["--seeds", str(seed)])
            environment = os.environ.copy()
            executable = Path(self.config.executable)
            if executable.is_absolute():
                environment_root = executable.parent.parent
                environment.setdefault("CUDA_HOME", str(environment_root))
                environment["PATH"] = str(executable.parent) + os.pathsep + environment.get("PATH", "")
                cuda_target = environment_root / "targets" / "x86_64-linux"
                if cuda_target.exists():
                    environment["CPATH"] = str(cuda_target / "include") + os.pathsep + environment.get("CPATH", "")
                    environment["LIBRARY_PATH"] = str(cuda_target / "lib") + os.pathsep + environment.get("LIBRARY_PATH", "")
                    environment["LD_LIBRARY_PATH"] = str(cuda_target / "lib") + os.pathsep + environment.get("LD_LIBRARY_PATH", "")
                compiler = executable.parent / "x86_64-conda-linux-gnu-gcc"
                compiler_cxx = executable.parent / "x86_64-conda-linux-gnu-g++"
                if compiler.exists() and compiler_cxx.exists():
                    environment.setdefault("CC", str(compiler))
                    environment.setdefault("CXX", str(compiler_cxx))
            run_generator_command(command, env=environment, timeout=getattr(self, "_autofold_timeout", None))
            designs = _designs(output, set(self.config.target_chains), segment.num_proposals, segment.sequence_length)
            if not designs:
                raise RuntimeError("PXDesign produced no parseable binder designs")
            segment.proposal_sequences = segment.proposal_sequences[: len(designs)]
            for proposal, (structure, sequence) in zip(segment.proposal_sequences, designs, strict=True):
                proposal.sequence = sequence
                proposal.structure = structure
                proposal._generator_metadata[self._spec.key] = {
                    "seed": seed,
                    "diffusionSteps": self.config.diffusion_steps,
                    "preset": self.config.preset,
                }


__all__ = [
    "BoltzGenBinderConfig",
    "BoltzGenBinderGenerator",
    "PXDesignBinderConfig",
    "PXDesignBinderGenerator",
]
