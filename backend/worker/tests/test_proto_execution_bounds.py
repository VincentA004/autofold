from __future__ import annotations

import unittest
import time
from types import SimpleNamespace

from autofold_worker.adapters.proto import _apply_trusted_generation_bounds


class _Config:
    def __init__(self, **values):
        self.__dict__.update(values)

    def model_copy(self, *, update):
        return _Config(**{**self.__dict__, **update})


class ProtoExecutionBoundsTests(unittest.TestCase):
    @staticmethod
    def _generator(key, **values):
        segment = SimpleNamespace(proposal_sequences=[object(), object(), object(), object()])
        calls = []

        def sample():
            calls.append(len(segment.proposal_sequences))

        return SimpleNamespace(
            _spec=SimpleNamespace(key=key),
            segment=segment,
            _sample=sample,
            calls=calls,
            **values,
        )

    def test_preserves_freebindcraft_internal_search_under_output_and_time_caps(self):
        design = _Config(max_trajectories=150, timeout=None)
        generator = self._generator(
            "freebindcraft",
            design_config=design,
            config=_Config(design_config=design),
        )
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        bundle = {
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 4, "maximumGpuSeconds": 900},
                    "generators": [{
                        "id": "freebindcraft",
                        "allocation": {"maximumCandidates": 2, "maximumGpuSeconds": 225},
                    }],
                }
            }
        }

        _apply_trusted_generation_bounds(program, bundle)
        generator._sample()

        self.assertEqual(generator.design_config.max_trajectories, 150)
        self.assertEqual(generator.design_config.timeout, 225)
        self.assertEqual(generator.config.design_config.max_trajectories, 150)
        self.assertEqual(generator.config.design_config.timeout, 225)
        self.assertEqual(generator.calls, [2])

    def test_preserves_stricter_agent_authored_bounds(self):
        design = _Config(max_trajectories=1, timeout=30)
        generator = self._generator(
            "freebindcraft",
            design_config=design,
            config=_Config(design_config=design),
        )
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        bundle = {
            "pipeline": {
                "generation": {
                    "budget": {"maximumCandidates": 4, "maximumGpuSeconds": 900},
                    "generators": [{
                        "id": "freebindcraft",
                        "allocation": {"maximumCandidates": 4, "maximumGpuSeconds": 900},
                    }],
                }
            }
        }

        _apply_trusted_generation_bounds(program, bundle)
        generator._sample()

        self.assertEqual(generator.design_config.max_trajectories, 1)
        self.assertEqual(generator.design_config.timeout, 30)

    def test_splits_rfdiffusion_sequential_tool_deadlines_and_caps_candidates(self):
        generator = self._generator(
            "rfdiffusion-mpnn-binder",
            config=_Config(
                rfdiffusion3_config=_Config(timeout=3600),
                proteinmpnn_config=_Config(timeout=3600),
                ligandmpnn_config=None,
            ),
        )
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        bundle = {
            "pipeline": {
                "generation": {
                    "generators": [{
                        "id": "rfdiffusion-mpnn-binder",
                        "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 900},
                    }],
                }
            }
        }

        _apply_trusted_generation_bounds(program, bundle)
        generator._sample()

        self.assertEqual(generator.calls, [1])
        self.assertEqual(generator.config.rfdiffusion3_config.timeout, 450)
        self.assertEqual(generator.config.proteinmpnn_config.timeout, 450)

    def test_rejects_a_second_sampling_call_after_candidate_allocation_is_spent(self):
        generator = self._generator("boltzgen-binder", config=_Config())
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        bundle = {
            "pipeline": {
                "generation": {
                    "generators": [{
                        "id": "boltzgen-binder",
                        "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 20},
                    }],
                }
            }
        }

        _apply_trusted_generation_bounds(program, bundle)
        generator._sample()
        with self.assertRaisesRegex(Exception, "exhausted its frozen candidate allocation"):
            generator._sample()
        self.assertEqual(generator.calls, [1])
        self.assertEqual(generator._autofold_timeout, 20)

    def test_enforces_independent_portfolio_lane_allocations(self):
        boltz = self._generator("boltzgen-binder", config=_Config())
        px = self._generator("pxdesign-binder", config=_Config())
        boltz_optimizer = SimpleNamespace(
            generators=[boltz],
            config=_Config(num_samples=3, num_results=1, proposal_batch_size=3),
            num_samples=3,
            num_results=1,
            proposal_batch_size=3,
            num_steps=3,
        )
        px_optimizer = SimpleNamespace(
            generators=[px],
            config=_Config(num_samples=3, num_results=2, proposal_batch_size=3),
            num_samples=3,
            num_results=2,
            proposal_batch_size=3,
            num_steps=3,
        )
        program = SimpleNamespace(optimizers=[
            boltz_optimizer,
            px_optimizer,
        ])
        bundle = {
            "pipeline": {
                "generation": {
                    "generators": [
                        {"id": "boltzgen-binder", "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 20}},
                        {"id": "pxdesign-binder", "allocation": {"maximumCandidates": 2, "maximumGpuSeconds": 30}},
                    ],
                }
            }
        }

        _apply_trusted_generation_bounds(program, bundle)
        boltz._sample()
        px._sample()

        self.assertEqual(boltz.calls, [1])
        self.assertEqual(px.calls, [2])
        self.assertEqual(boltz._autofold_timeout, 20)
        self.assertEqual(px._autofold_timeout, 30)
        self.assertEqual(
            (boltz_optimizer.num_samples, boltz_optimizer.proposal_batch_size, boltz_optimizer.num_steps),
            (1, 1, 1),
        )
        self.assertEqual(
            (px_optimizer.num_samples, px_optimizer.num_results, px_optimizer.proposal_batch_size),
            (2, 2, 2),
        )
        self.assertEqual(boltz_optimizer.config.num_samples, 1)
        self.assertEqual(px_optimizer.config.proposal_batch_size, 2)
        self.assertEqual(boltz._autofold_sampling, {
            "generator": "boltzgen-binder",
            "allocatedCandidates": 1,
            "maximumGpuSeconds": 20,
            "candidateCap": 1,
            "authoredSamples": 3,
            "effectiveSamples": 1,
            "authoredProposalBatchSize": 3,
            "effectiveProposalBatchSize": 1,
            "authoredResults": 1,
            "effectiveResults": 1,
        })
        self.assertEqual(px._autofold_sampling["authoredSamples"], 3)
        self.assertEqual(px._autofold_sampling["effectiveSamples"], 2)
        self.assertEqual(px._autofold_sampling["effectiveResults"], 2)

    def test_rejects_duplicate_generator_objects_and_missing_declared_lanes(self):
        duplicate = self._generator("boltzgen-binder", config=_Config())
        program = SimpleNamespace(optimizers=[
            SimpleNamespace(generators=[duplicate]),
            SimpleNamespace(generators=[duplicate]),
        ])
        bundle = {
            "pipeline": {
                "generation": {
                    "generators": [{
                        "id": "boltzgen-binder",
                        "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 20},
                    }],
                }
            }
        }
        with self.assertRaisesRegex(Exception, "cannot be reused"):
            _apply_trusted_generation_bounds(program, bundle)

        missing = SimpleNamespace(optimizers=[])
        with self.assertRaisesRegex(Exception, "absent from the Proto program"):
            _apply_trusted_generation_bounds(missing, bundle)

    def test_hard_deadline_interrupts_a_slow_non_freebind_lane(self):
        generator = self._generator("boltzgen-binder", config=_Config())

        def slow_sample():
            time.sleep(5)

        generator._sample = slow_sample
        program = SimpleNamespace(optimizers=[SimpleNamespace(generators=[generator])])
        bundle = {
            "pipeline": {
                "generation": {
                    "generators": [{
                        "id": "boltzgen-binder",
                        "allocation": {"maximumCandidates": 1, "maximumGpuSeconds": 1},
                    }],
                }
            }
        }
        _apply_trusted_generation_bounds(program, bundle)
        started = time.monotonic()
        with self.assertRaisesRegex(Exception, "exceeded its frozen GPU-time allocation"):
            generator._sample()
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()
