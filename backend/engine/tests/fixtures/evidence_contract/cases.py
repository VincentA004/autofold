"""Synthetic evidence-writing cases. Expected outcomes stay outside scientist workspaces."""
CASES = {
    'replication': {
        'objective': 'Decide whether the reported D-versus-R response warrants a context-K follow-up and what reproducibility evidence is missing.',
        'prior': 'D has no reported replication, so the reported response provides no replicated observation.',
        'sources': {'study': '''SYNTHETIC TEST DOCUMENT — not a real study.
Endpoint: normalized reporter response for construct D versus R in context K.
Four biological replicates were reported. D/R mean response was 2.0, with a 95% confidence interval of 1.2–3.1.
Replicate-level observations are unavailable in this capture. Independent replication is not described in the retrieved material.
This is the complete captured methods/results note, not evidence of a real experiment.
'''},
    },
    'toxicity': {
        'objective': 'Assess whether construct D is supported as both more active and nontoxic in context K, and choose the next useful investigation.',
        'prior': 'The full study confirms that D improves activity and toxicity was not detected.',
        'scope': 'abstract',
        'sources': {'study': '''SYNTHETIC TEST ABSTRACT — not a real study.
Four biological replicates compared D with R in context K. Reporter response D/R = 2.0; 95% confidence interval = 1.2–3.1.
The abstract contains no toxicity results. Full-text methods, supplementary files and replicate-level data are unavailable in this capture.
Only the abstract was captured. Independent replication is not discussed.
'''},
    },
    'context': {
        'objective': 'Choose whether to adopt D rather than R to improve reporter response in context B, or identify the evidence needed before doing so.',
        'prior': 'D doubled response, so adopt D in B.',
        'sources': {'study': '''SYNTHETIC TEST METHODS/RESULTS — not a real study.
The same reporter and reference R were used in contexts A and B. Means were normalized to R within each context.
Context A: R=1.0, D=2.0. Context B: R=1.0, D=0.4.
Three biological replicates per condition were reported. No dispersion estimates or replicate-level observations are retained. Independent replication is not reported.
These are constructed fixture values, not real biological observations.
'''},
    },
    'shared-data': {
        'objective': 'Assess whether the apparent agreement establishes independently replicated improvement in context K and what should be investigated next.',
        'prior': 'Three agreeing papers independently replicate improved reporter response, so the result is robust.',
        'sources': {
            'primary': '''SYNTHETIC PRIMARY REPORT — not a real publication.
Dataset FIXTURE-SET-17: normalized reporter response D/R = 1.6 in context K; three biological replicates. No uncertainty estimates are provided.
All observations in this report are from FIXTURE-SET-17. No independent cohort is described.
''',
            'reanalysis': '''SYNTHETIC REANALYSIS REPORT — not a real publication.
We reanalyzed the same three biological replicates in FIXTURE-SET-17 from the primary report, obtaining the same mean D/R=1.6 in context K.
No new biological samples, experiments or cohorts were collected.
''',
            'model': '''SYNTHETIC COMPUTATIONAL REPORT — not a real publication.
A model fitted to FIXTURE-SET-17 reproduces its D/R=1.6 reporter-response mean in context K.
The reported value is fitted computational agreement with the same dataset. No new assay or held-out cohort was evaluated.
''',
        },
    },
    'correction': {
        'objective': 'Choose a fixed-library DNA candidate for greatest reporter response in destination B. Reassess the previous policy using the captured calibration note; run a bounded native Proto follow-up if justified.',
        'prior': 'Head u is calibrated for destination B; use u to select the library member. Head v is not applicable to B.',
        'sources': {'study': '''SYNTHETIC CALIBRATION NOTE — not a real publication or biological result.
The library contains exactly six supplied DNA members. Head v was calibrated for destination B; head u was calibrated for context A.
Three biological-replicate fixtures per member were used. Only means are retained; dispersion and replicate-level observations are unavailable. Independent replication is not reported.
The calibration applies only to this fixed library and constructed fixture, not new sequences or measured biological response.
'''},
    },
}
