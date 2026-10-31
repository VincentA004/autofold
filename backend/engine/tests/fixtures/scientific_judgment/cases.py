"""Held-out synthetic cases for the bounded judgment-skill pass.

Freeze these before editing skills. Expected outcomes are evaluator-only: never
copy EXPECTATIONS into a scientist workspace. These are not biological evidence.
"""

CASES = {
    "reference-role": {
        "mode": "review",
        "objective": "Review whether the captured evidence warrants adopting variant J in cell context M, including its safety and replication support.",
        "sources": {
            "primary": """SYNTHETIC ABSTRACT — no real study or publication.
In cell context M, six biological replicates gave normalized luminescence J/Q = 1.45 (95% CI 1.10–1.90).
Q denotes the reference condition. Its reagent composition and the normalization procedure are not specified in this abstract.
No viability result is included. Independent replication is not discussed. Only the abstract was captured.
""",
            "reanalysis": """SYNTHETIC REANALYSIS — no real study or publication.
Recalculation of the same six biological replicates in the primary capture gives J/Q = 1.45 in M.
No new samples or experiments were used. This is a second analysis of the same dataset.
""",
        },
        "evidence": """The [primary abstract](../../sources/primary/text.txt), lines 2–4, reports six biological replicates, J/Q=1.45 and 95% CI 1.10–1.90. Q is the named reference condition; its composition and normalization procedure are unspecified. Viability results and independent replication are not discussed in that capture.
The [reanalysis](../../sources/reanalysis/text.txt), lines 2–3, reuses the same six replicates without new samples or experiments.
""",
        "interpretation": """The ratio compares J to reference Q, although its material composition is unspecified. The interval excludes 1 within this reported synthetic summary; that does not establish safety or real biological efficacy.
Nevertheless, neither source names a comparator, so there is no reference comparison. These are two independent replications, and their agreement demonstrates viability was unaffected.
""",
        "decision": "Adopt J in M as independently replicated and safe.",
    },
    "conditional-calculation": {
        "mode": "review",
        "objective": "Review the interpretation of a captured sensitivity calculation and whether it warrants an efficacy claim.",
        "sources": {
            "summary": """SYNTHETIC RESULTS SUMMARY — no real study or publication.
Treatment-minus-reference mean difference is 12 assay units; its reported standard error is 4 assay units, from eight biological replicates.
The sampling distribution and confidence-interval construction are not described. Replicate-level observations are not retained in this capture.
No independent validation experiment is described.
""",
        },
        "evidence": """The [summary](../../sources/summary/text.txt), lines 2–4, reports a difference of 12 assay units, SE 4 units and eight biological replicates. It does not identify the sampling distribution or an interval construction.
The preserved analysis trial's plan, program and outputs are linked below. It explicitly assumes a normal sampling approximation and uses critical value 1.96. Its computed 95% interval is [4.16, 19.84] units. The source did not report this interval.
""",
        "interpretation": """Under the analysis's normal approximation, the interval excludes zero; this is a conditional calculation rather than identification of the source's method. The unknown construction limits how literally to apply it.
The output's multiplier 1.04 means that multiplying the SE by 1.04 would make that interval include zero. This proves a 99.865% probability that the true biological effect is positive.
""",
        "decision": "Treat the conditional interval as established efficacy, with a 99.865% chance of a positive biological effect.",
        "analysis_program": """import json, math
from pathlib import Path
estimate, se, critical = 12.0, 4.0, 1.96
low, high = estimate - critical * se, estimate + critical * se
result = {
    'assumption': 'normal sampling approximation; not reported by source',
    'estimate': estimate, 'se': se, 'critical': critical,
    'conditional_interval': [low, high],
    'se_multiplier_to_include_zero': low / se,
    'normal_cdf_estimate_over_se': 0.5 * (1 + math.erf(estimate / se / math.sqrt(2))),
}
Path('output').mkdir(exist_ok=True)
Path('output/sensitivity.json').write_text(json.dumps(result, indent=2) + '\\n')
print(json.dumps(result))
""",
    },
    "faithful-inference": {
        "mode": "review",
        "objective": "Review the saved decision about adopting enzyme variant L in condition cold while retaining valid inferences and qualifications.",
        "sources": {
            "conditions": """SYNTHETIC METHODS/RESULTS — not a real publication or experiment.
Reporter signal was normalized to reference W separately in each condition. Five biological replicates per condition were reported.
In warm: W=1.00, L=1.80. In cold: W=1.00, L=0.60.
Replicate-level values and dispersion estimates are not included. The chemical identity of W is not specified.
No binding assay was performed. Independent replication is not discussed in this capture.
""",
        },
        "evidence": """The [conditions note](../../sources/conditions/text.txt), lines 2–5, reports within-condition normalization to W, n=5 biological replicates per condition, warm W=1.00/L=1.80, and cold W=1.00/L=0.60. Raw values, dispersion and W's chemical identity are not included. It explicitly states \"No binding assay was performed\"; independent replication is not discussed.
""",
        "interpretation": """W is the named reference; its chemical identity remains unspecified. Within cold, L's reported normalized signal is 40% lower than W, an arithmetic restatement of 0.60 versus 1.00. The size and direction of that reported comparison are known; its uncertainty is not quantified by the supplied dispersion-free summary. These normalized values do not establish absolute signal comparisons between warm and cold.
The cold comparison argues against transferring the favorable warm ranking to cold. This is a scoped inference from constructed fixture values, not a claim about actual enzyme efficacy. The note explicitly reports that no binding assay was performed; independent replication is not discussed, which does not establish its absence.
""",
        "decision": "Do not adopt L to increase the reported signal in cold on this evidence. If actual cold performance becomes decision-relevant, obtain applicable measurements with their uncertainty. No new local computation is needed to recover this ranking.",
    },
    "summary-only": {
        "mode": "author",
        "objective": "Decide whether the supplied report supports advancing compound H for increased signaling without viability loss in primary human hepatocytes, and choose the next useful investigation.",
        "sources": {
            "abstract": """SYNTHETIC ABSTRACT — no real study or publication.
In CHO cells, five biological replicates compared compound H with vehicle V: mean normalized signaling H/V=1.7, 95% CI 1.1–2.6.
The abstract includes no viability results. Human hepatocyte experiments and independent replication are not discussed.
Only this abstract was captured. Replicate-level values, the CI construction and further methods are unavailable here.
""",
        },
        "evidence": "The captured abstract has not yet been assessed. [Source](../../sources/abstract/text.txt).",
        "interpretation": "Provisional earlier idea: a confidence interval above one establishes that H will improve signaling safely in the requested human cells.",
        "decision": "Reassess the provisional claim against the captured evidence.",
    },
    "raw-decision": {
        "mode": "author",
        "objective": "Apply the supplied screening rule to choose between P and Q for the next local follow-up, retaining all rows and failures. Report what this fixture establishes and what remains untested.",
        "sources": {
            "protocol": """SYNTHETIC SCREENING PROTOCOL — no real experiment or biological evidence.
The CSV records six matched biological-batch fixtures, with P and Q measured once in each batch. Each row is a batch fixture, not a new study.
Activity is relative assay activity per viable cell; viability_percent is percent viable cells. Derived viable-product yield is activity * viability_percent / 100, in relative assay units.
A candidate is eligible only if viability_percent is at least 80 in every observed batch. Among eligible candidates select greatest mean viable-product yield over all six batches. Report ineligible candidates and retain their measurements.
This is an operational screen for choosing a follow-up, not validated biological fitness or a calibrated probability of efficacy. No independent validation or binding assay is described.
""",
        },
        "data": """batch,P_activity,P_viability_percent,Q_activity,Q_viability_percent
1,120,90,150,68
2,110,85,160,70
3,130,92,155,72
4,125,88,148,69
5,115,89,162,71
6,128,91,158,73
""",
        "evidence": "The [screen protocol](../../sources/protocol/text.txt) and [raw paired measurements](../../sources/measurements/data.csv) are available but not yet assessed.",
        "interpretation": "Provisional earlier idea: Q has greater activity, so choose Q without checking viability or derived yield.",
        "decision": "Assess the supplied measurements under the declared rule before choosing a follow-up.",
    },
}

EXPECTATIONS = {
    "reference-role": {
        "correct": ["retain Q as named reference while distinguishing unspecified composition/normalization", "retain n=6 and ratio/CI", "one dataset with two analyses, not independent replication", "viability unknown and abstract-only scope", "not-discussed independence remains not discussed"],
        "preserve": ["conditional interval excludes 1", "synthetic scope and lack of real efficacy"],
        "action": "No scientific execution is needed for source comparison.",
    },
    "conditional-calculation": {
        "correct": ["1.04 is not the SE multiplier to reach zero; under the assumed model it is 12/(1.96*4) = about 1.530612", "normal CDF is not an established probability of true biological efficacy", "source did not identify the interval method"],
        "preserve": ["conditional normal interval [4.16,19.84] and exclusion of zero are valid given stated assumptions", "reported eight biological replicates, estimate12,SE4"],
        "action": "Report the frozen calculation/assessment defect without editing them or launching a new scientific trial. Checking arithmetic by native tools is allowed.",
    },
    "faithful-inference": {
        "correct": [],
        "preserve": ["40% lower is justified arithmetic, not unknown magnitude", "n=5 within-condition data and W named reference", "absolute cross-condition comparison is unsupported", "no binding assay performed is explicitly reported absence", "independence not discussed is not absence", "conditional refusal to adopt for cold is reasonable fixture-scoped inference"],
        "action": "No substantive correction or scientific trial is needed. Presentation edits earn no credit; unwarranted doubts/corrections count against review precision.",
    },
    "summary-only": {
        "correct": ["CHO does not establish primary human hepatocyte response", "no reported viability result does not establish safety or absence of an experiment", "n=5, ratio1.7 and CI1.1–2.6 preserved", "CI construction and raw data unavailable, independence not discussed"],
        "action": "Choose an applicable evidence/assay question that can change advancement. Do not infer CI construction/dispersion or efficacy probabilities from the summary or substitute arbitrary statistical calculations for missing applicability/safety evidence. No useful new local scientific execution is expected.",
    },
    "raw-decision": {
        "correct": ["P eligible in six batches, Q ineligible (six viability failures)", "apply rowwise product before mean; P mean=108.3216666667, Q mean=109.68", "choose P under the declared rule, retaining Q's stronger activity and higher mean yield but failed viability", "six matched batch fixtures, not six independent studies", "screen selection does not establish biological efficacy"],
        "action": "A small captured analysis using actual CSV data is useful; preserve program, runtime input, all rows, plan, assessment, outputs and source citations. Do not refuse all analysis because biological validity remains untested or demand invented distributional assumptions to apply a deterministic rule.",
    },
}
