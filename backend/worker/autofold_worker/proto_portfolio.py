"""Trusted composition of independent native Proto programs.

Proto's Program intentionally requires sequential optimizers to share construct
objects. Binder portfolios instead need independent constructs and generators
whose candidates compete only after generation. This wrapper keeps every lane
as a normal Proto Program, executes them serially on one GPU worker, and exposes
their optimizers/constructs to Autofold's allocation and provenance guards.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


def _lane_generator(program: Any) -> str | None:
    identifiers = {
        (
            getattr(generator, "_autofold_generator_id", None)
            or getattr(getattr(generator, "_spec", None), "key", None)
        )
        for optimizer in getattr(program, "optimizers", [])
        for generator in getattr(optimizer, "generators", [])
    }
    identifiers.discard(None)
    return next(iter(identifiers)) if len(identifiers) == 1 else None


class ProtoPortfolioProgram:
    def __init__(self, lanes: Iterable[Any]) -> None:
        raw = list(lanes)
        self.lanes = [
            lane if isinstance(lane, ProtoPortfolioLane) else ProtoPortfolioLane(program=lane)
            for lane in raw
        ]
        self.programs = [lane.program for lane in self.lanes]
        self.lane_failures: list[dict[str, str | int]] = []
        if not self.programs:
            raise ValueError("A Proto portfolio requires at least one native Program lane")
        construct_owners: dict[int, int] = {}
        for program in self.programs:
            if not callable(getattr(program, "run", None)):
                raise TypeError("Every Proto portfolio lane must expose run()")
            if not getattr(program, "optimizers", None):
                raise ValueError("Every Proto portfolio lane requires an optimizer")
        for index, program in enumerate(self.programs):
            for construct in getattr(program, "constructs", []):
                identity = id(construct)
                if identity in construct_owners:
                    raise ValueError(
                        "Proto portfolio lanes must own independent Construct objects; "
                        f"lanes {construct_owners[identity]} and {index} share one construct"
                    )
                construct_owners[identity] = index

    @property
    def optimizers(self) -> list[Any]:
        return [optimizer for program in self.programs for optimizer in program.optimizers]

    @property
    def constructs(self) -> list[Any]:
        return [construct for program in self.programs for construct in program.constructs]

    def run(self) -> None:
        completed = 0
        for index, program in enumerate(self.programs):
            try:
                program.run()
                completed += 1
            except Exception as error:
                self.lane_failures.append({
                    "lane": index,
                    **({"generator": generator} if (generator := _lane_generator(program)) else {}),
                    "errorType": type(error).__name__,
                    "message": str(error),
                })
        if completed == 0:
            summary = "; ".join(
                f"lane {item['lane']}: {item['errorType']}: {item['message']}"
                for item in self.lane_failures
            )
            raise RuntimeError(f"Every Proto portfolio lane failed: {summary}")

    def autofold_generation_plan(self) -> dict[str, Any]:
        """Return the agent-authored lane budget for trusted compilation.

        Generator identity is derived from the native Proto objects rather than
        repeated in a separate workflow manifest. The TypeScript compiler and
        remote worker both validate this description against installed
        registries and the frozen experiment budget.
        """
        allocations: list[dict[str, Any]] = []
        generators: list[str] = []
        for index, lane in enumerate(self.lanes):
            generator = _lane_generator(lane.program)
            if generator is None:
                raise ValueError(f"Proto portfolio lane {index} must contain exactly one registered generator")
            if lane.maximum_candidates is None or lane.maximum_gpu_seconds is None:
                raise ValueError(
                    "Direct Proto portfolio lanes require maximum_candidates and maximum_gpu_seconds"
                )
            generators.append(generator)
            allocations.append({
                "generator": generator,
                "maximumCandidates": lane.maximum_candidates,
                "maximumGpuSeconds": lane.maximum_gpu_seconds,
            })
        if len(set(generators)) != len(generators):
            raise ValueError("A direct Proto portfolio may declare each generator only once")
        return {
            "generators": generators,
            "allocations": allocations,
            "maximumCandidates": sum(item["maximumCandidates"] for item in allocations),
            "maximumGpuSeconds": sum(item["maximumGpuSeconds"] for item in allocations),
        }


@dataclass(frozen=True)
class ProtoPortfolioLane:
    """One independently executable Proto program and its bounded search allocation."""

    program: Any
    maximum_candidates: int | None = None
    maximum_gpu_seconds: int | None = None
    name: str | None = None

    def __post_init__(self) -> None:
        for field, value in (
            ("maximum_candidates", self.maximum_candidates),
            ("maximum_gpu_seconds", self.maximum_gpu_seconds),
        ):
            if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value <= 0):
                raise ValueError(f"{field} must be a positive integer")


__all__ = ["ProtoPortfolioLane", "ProtoPortfolioProgram"]
