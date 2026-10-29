# Grader evaluation

Method (spec §8.5): 61 student explanations of five topics from the *Intro to Machine Learning* subject
(Gradient Descent, Backpropagation, Chain rule, Overfitting, Loss functions), covering strong, partial, wrong,
vague and Hinglish answers. Every claim was hand-labelled covered / missing / wrong using the F2 rules (263 labels).
The grader sees the topic, its claims, the note chunks and the explanation. Every covered/wrong verdict must quote
the student's words verbatim, which is checked on every run.

The set is split into **dev** (42 explanations, 180 labels), used to tune the built-in engine,
and **held-out test** (19 explanations, 83 labels), which is only scored. The headline number is the
held-out one. The **Hinglish** slice (18 explanations) spans both splits. The built-in engine is deterministic,
so reruns give identical numbers.

Protocol note: the first 35 explanations were written and scored once with the untuned engine (builtin-v1) before the
split was fixed and 14 more were added; all tuning after that used dev disagreements only. Later, 12 more dev explanations were
added (paraphrases, role swaps, absolute claims, formula errors), labelled before scoring. Labels were never changed to fit the grader.

Data: `eval/claims.json` (claims + note pages), `eval/dataset.json` (explanations, labels, split).
Run: `npm run eval` (`npx tsx eval/run.ts`; add `--verbose` to list dev disagreements). The model grader runs as a
separate row when an AI key is set (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or LLM_BASE_URL + LLM_API_KEY).

Regression test: `npx tsx eval/samples.test.ts` checks that every suggested explanation in the sample workspace
grades as exactly 1 wrong + 2 missing, and prints which claim was marked wrong.

## Latest run

| Engine | Version | Held-out agreement | Dev agreement | Hinglish | All |
|---|---|---|---|---|---|
| built-in | builtin-v6 | **84.3%** | 95.6% | 89.6% | 92.0% |

Per status on the held-out set (precision / recall):

| Engine | Covered | Missing | Wrong | Speed |
|---|---|---|---|---|
| built-in | 100.0% / 77.8% | 71.4% / 96.8% | 92.3% / 75.0% | 14 ms per explanation |

## Versions

| Date | Engine | Version | Held-out | Dev | Note |
|---|---|---|---|---|---|
| 2026-10-28 | built-in | builtin-v1 | 73.5% | 79.7% | baseline before tuning (dev = original 30 items) |
| 2026-10-28 | built-in | builtin-v3 | 84.3% | 93.0% | sibling-claim check, clause binding, punctuation-bounded negation, calibrated on dev (dev = original 30 items) |
| 2026-10-28 | built-in | builtin-v5 | 84.3% | 95.6% | role/direction swaps, absolute qualifiers, formula shape, mismatch-free coverage, paraphrase lexicon; 12 dev items added |
| 2026-10-28 | built-in | builtin-v6 | 84.3% | 95.6% | gemini-2.5-flash, free tier |

## How the built-in engine works

A deterministic semantic matcher: stemming, an ML/science synonym and paraphrase lexicon (including common Hinglish
words), IDF-weighted concept overlap across the subject's claims, bigrams, and number/formula matching. Contradictions
are found with scoped negation, antonym pairs (larger/smaller, increase/decrease, forward/backward, input/output,
maximise/minimise, before/after, add/multiply, regression/classification) and per-clause attribute binding
(for example "high training error, low test error" against the notes), training/validation and other role swaps, from/to
direction order, absolute qualifiers ("only", "always") that the notes do not support, and formula shape (f'(x)·g'(x) vs
f'(g(x))·g'(x)). A span that contradicts a claim is never used as evidence that the claim is covered. It needs no API key.
