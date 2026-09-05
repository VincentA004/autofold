from __future__ import annotations

import unittest
from types import SimpleNamespace

from autofold_worker.proto_portfolio import ProtoPortfolioLane, ProtoPortfolioProgram


class ProtoPortfolioProgramTests(unittest.TestCase):
    def test_runs_independent_lanes_and_flattens_trusted_inventory(self):
        calls = []
        first = SimpleNamespace(
            optimizers=[object()],
            constructs=["first"],
            run=lambda: calls.append("first"),
        )
        second = SimpleNamespace(
            optimizers=[object()],
            constructs=["second"],
            run=lambda: calls.append("second"),
        )

        portfolio = ProtoPortfolioProgram([first, second])
        portfolio.run()

        self.assertEqual(calls, ["first", "second"])
        self.assertEqual(len(portfolio.optimizers), 2)
        self.assertEqual(portfolio.constructs, ["first", "second"])

    def test_rejects_an_empty_portfolio(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            ProtoPortfolioProgram([])

    def test_isolates_one_lane_failure_and_continues_remaining_lanes(self):
        calls = []
        failed = SimpleNamespace(
            optimizers=[object()],
            constructs=["failed"],
            run=lambda: (_ for _ in ()).throw(RuntimeError("bounded timeout")),
        )
        completed = SimpleNamespace(
            optimizers=[object()],
            constructs=["completed"],
            run=lambda: calls.append("completed"),
        )

        portfolio = ProtoPortfolioProgram([failed, completed])
        portfolio.run()

        self.assertEqual(calls, ["completed"])
        self.assertEqual(portfolio.lane_failures, [{
            "lane": 0,
            "errorType": "RuntimeError",
            "message": "bounded timeout",
        }])

    def test_raises_when_every_lane_fails(self):
        failed = SimpleNamespace(
            optimizers=[object()],
            constructs=["failed"],
            run=lambda: (_ for _ in ()).throw(RuntimeError("no candidate")),
        )
        with self.assertRaisesRegex(RuntimeError, "Every Proto portfolio lane failed"):
            ProtoPortfolioProgram([failed]).run()

    def test_attributes_a_failed_lane_to_its_trusted_generator(self):
        generator = SimpleNamespace(_autofold_generator_id="pxdesign-binder")
        failed = SimpleNamespace(
            optimizers=[SimpleNamespace(generators=[generator])],
            constructs=["failed"],
            run=lambda: (_ for _ in ()).throw(FileNotFoundError("pxdesign")),
        )

        with self.assertRaisesRegex(RuntimeError, "Every Proto portfolio lane failed"):
            portfolio = ProtoPortfolioProgram([failed])
            portfolio.run()
        self.assertEqual(portfolio.lane_failures[0]["generator"], "pxdesign-binder")

    def test_compiles_generator_allocations_from_the_executable_composite(self):
        def program(generator_id):
            generator = SimpleNamespace(_autofold_generator_id=generator_id)
            return SimpleNamespace(
                optimizers=[SimpleNamespace(generators=[generator])],
                constructs=[object()],
                run=lambda: None,
            )

        portfolio = ProtoPortfolioProgram([
            ProtoPortfolioLane(program("boltzgen-binder"), maximum_candidates=3, maximum_gpu_seconds=1200),
            ProtoPortfolioLane(program("rfdiffusion-mpnn-binder"), maximum_candidates=2, maximum_gpu_seconds=2400),
        ])

        self.assertEqual(portfolio.autofold_generation_plan(), {
            "generators": ["boltzgen-binder", "rfdiffusion-mpnn-binder"],
            "allocations": [
                {"generator": "boltzgen-binder", "maximumCandidates": 3, "maximumGpuSeconds": 1200},
                {"generator": "rfdiffusion-mpnn-binder", "maximumCandidates": 2, "maximumGpuSeconds": 2400},
            ],
            "maximumCandidates": 5,
            "maximumGpuSeconds": 3600,
        })

    def test_derives_preflight_identity_from_the_registered_generator_spec(self):
        generator = SimpleNamespace(_spec=SimpleNamespace(key="boltzgen-binder"))
        program = SimpleNamespace(
            optimizers=[SimpleNamespace(generators=[generator])],
            constructs=[object()],
            run=lambda: None,
        )
        portfolio = ProtoPortfolioProgram([
            ProtoPortfolioLane(program, maximum_candidates=1, maximum_gpu_seconds=30),
        ])
        self.assertEqual(portfolio.autofold_generation_plan()["generators"], ["boltzgen-binder"])

    def test_rejects_shared_constructs_between_independent_lanes(self):
        shared = object()
        first = SimpleNamespace(optimizers=[object()], constructs=[shared], run=lambda: None)
        second = SimpleNamespace(optimizers=[object()], constructs=[shared], run=lambda: None)
        with self.assertRaisesRegex(ValueError, "independent Construct objects"):
            ProtoPortfolioProgram([first, second])


if __name__ == "__main__":
    unittest.main()
