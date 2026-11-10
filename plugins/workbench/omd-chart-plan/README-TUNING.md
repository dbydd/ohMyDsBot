# Chart Planner & Judge Consumer: Tuning & Evaluation Report

## Overview
This document records the empirical results of wiring the System One decision-model judge into `omd-table-chart` and tuning the questions, criteria, and confidence thresholds in `omd-chart-plan`.

Evaluation was performed against the live Magpie gateway endpoint (`http://127.0.0.1:3425/v1/systemone`) running `group/decider` (`d3-flash-oQ8e`).

---

## Architecture & Integration

1. **Deterministic Authority**:
   - `analyzeTable`, `planChart`, and structural validations (`compositionOf`, `adds`, `shouldJudge`) execute as pure functions without I/O.
   - Exact sum relations (`analysis.composition`) strictly override judge choices with `structural-override`.

2. **Configurable Operating Modes**:
   - `mode: 'off'`: zero records written, 0 model calls.
   - `mode: 'heuristic'`: plans from table numbers alone, 0 model calls, records marked `decidedBy: { role: 'heuristic' }`.
   - `mode: 'judge'`: checks `shouldJudge(analysis, plan)`. Small or ineligible tables (<3 rows or <2 measures) skip the judge and record `decidedBy: { role: 'heuristic' }` without model calls. Eligible tables query `ctx.judgment.judge` with closed choice questions and record `decidedBy: { role: 'judge', provider, model, api }` along with a full auditable `trace`.

3. **Invariants & Safety**:
   - One chart per assistant message (`anchorSeq` deduplication).
   - WeakMap-based per-agent cancellation controllers ensure late results from aborted or disposed agents are discarded cleanly.
   - Fail-closed behavior: unavailable or failed judge results log diagnostic hints rather than emitting broken or unvetted charts.

---

## Tuning Changes & Rationales

### 1. Agent-Centric Explanatory Prompts
- **Before**: Brief imperative prompts (e.g. `A chart will be drawn under the table... Choose none when no single row stands out.`).
- **After**: Structured explanations treating the judge model as an intelligent reasoning agent:
  - *Decision Purpose*: explains what visual element is being determined.
  - *What the reader will see*: concrete description of the user experience.
  - *What goes wrong under the wrong choice*: explicitly details the failure mode (e.g., misrepresenting a pipeline as a contest, or reversing polarity colors).
- **Result**: Drastically higher model focus and decisive probability separation (e.g., focus on recommended model jumped from 0.455 to 0.848, then 0.956 with explained criteria).

### 2. Concrete Criteria Annotations
- Criteria options are accompanied by explicit situational criteria instead of `null` or bare names.
- Example for focus: `options[name] = "Focus on row \"${name}\": this row represents the primary recommendation, proposed modification, or baseline reference under evaluation."`.

### 3. Threshold Calibration
- `ORDER_CONFIDENCE = 0.6`: Prevents reordering tables that may already have intentional author ordering unless ranking is clear.
- `POLARITY_CONFIDENCE = 0.7`: Polarity controls color semantics (green vs. red). Mislabeling inverts good/bad signals; 0.7 ensures high certainty.
- `RIVALS_CONFIDENCE = 0.7`: Prevents displaying competitive badges on sequential stages or unrelated rows.
- `FOCUS_CONFIDENCE = 0.75` / `AGREED_FOCUS_CONFIDENCE = 0.4`: If the author already formatted a row in markdown (bold, `(current)`), 0.4 is sufficient; unformatted rows require 0.75.
- `TITLE_CONFIDENCE = 0.4` / `PLAIN_TITLE_CONFIDENCE = 0.75`: Whole-table trends require only 0.4; single-cell restatements require 0.75.
- `COLUMN_CONFIDENCE = 0.5`: Standard binary inclusion gate.

---

## Empirical Benchmark Results

Test run command:
```bash
bun ./plugins/workbench/omd-chart-plan/samples/run-samples.ts
```

### Tuning Suite (5 Samples)

| ID | Description | Pre Kind | Post Kind | Real Judge Outcome | Audit Trace Notes |
|---|---|---|---|---|---|
| `tuning-1-models-multi-unit` | Model comparison (latency ms, pass %, cost $) | `multiples` | `multiples` | Adopted kind, c1..c3, rivals (rows), p1..p3, focus (Model Beta) | Order kept `table` (conf 0.57 < 0.60 gate). Title below gate (0.36 < 0.75). |
| `tuning-2-composition-tokens` | Token usage breakdown (cached + prompt + completion = total) | `stacked` | `stacked` | Structural override enforced | Judge kind `grouped` overridden by `analysis.composition` (`structural-override`). c4 total column excluded. |
| `tuning-3-temporal-timeline` | Daily active users & signups over ISO dates | `line` | `line` | Adopted line kind, c1, c2 | Temporal ordering preserved. Trend title conf 0.39 close to 0.40 gate. |
| `tuning-4-prose-nonchart` | Architectural status table with prose descriptions | N/A | N/A | Rejected by deterministic gates | 0 model calls spent. |
| `tuning-5-ineligible-small` | 2-row single-measure table | N/A | N/A | Rejected by deterministic gates | 0 model calls spent. |

### Held-out Suite (5 Samples)

| ID | Description | Pre Kind | Post Kind | Real Judge Outcome | Audit Trace Notes |
|---|---|---|---|---|---|
| `heldout-1-server-hardware-benchmark` | Server instances (throughput, p99 ms, monthly cost $) | `multiples` | `multiples` | Adopted kind, c1..c3, rivals (rows), p1..p3, focus (c7g.2xlarge) | Rivals shifted to `rows` with 0.97 confidence. Focus adopted with 0.74 conf. |
| `heldout-2-memory-allocation-composition` | Memory footprint by subsystem (heap, stack, off-heap = total) | `grouped` | `stacked` | Correctly adopted `stacked` | Model recognized composition; c4 total excluded; `stacked` adopted. |
| `heldout-3-release-version-progression` | Release versions tracking bundle size & startup time | `multiples` | `line` | Upgraded to `line` | Judge recognized sequential version progression (`conf=0.51`). Adopted line chart with lower polarity on both metrics. |
| `heldout-4-task-tracker-prose` | Sprint task breakdown | N/A | N/A | Rejected by deterministic gates | 0 model calls spent. |
| `heldout-5-mixed-ineligible-units` | 2-row test runs | N/A | N/A | Rejected by deterministic gates | 0 model calls spent. |

---

## Parent Profile Configuration

To activate judge mode in the parent runtime profile (e.g. `profiles/omd-full/cordis.patch.yml` or private profile):

```yaml
- insert:
    - id: omd-table-chart
      name: omd-table-chart
      config:
        mode: judge
        minRows: 2
        pickTimeoutMs: 15000
        maxQuestions: 25
        maxTableChars: 4000
```

When `omd-judgment` is mounted with candidate `magpie/group/decider`, `omd-table-chart` resolves it automatically via `ctx.get('judgment')`. If the service is absent or `mode` is set to `heuristic`, it falls back cleanly to deterministic planning with zero network or model overhead.
