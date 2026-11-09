#!/usr/bin/env bun
/**
 * Benchmark runner: runs tuning and heldout sample suites against the real Magpie
 * System One judge (http://127.0.0.1:3425/v1/systemone) and evaluates judgment outcomes,
 * confidence margins, structural overrides, and pre/post tuning comparisons.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeTable,
  planChart,
  buildSpec,
  shouldJudge,
  buildChartState,
  buildChartQuestions,
  mergeChartAnswers,
} from '../src/index.ts'

interface Sample {
  id: string
  description: string
  markdown: string
}

interface Dataset {
  tuning: Sample[]
  heldout: Sample[]
}

const data: Dataset = JSON.parse(
  readFileSync(join(import.meta.dir, 'chart-samples.json'), 'utf8'),
)

async function testSample(sample: Sample) {
  console.log(`\n================================================================`);
  console.log(`SAMPLE: ${sample.id}`);
  console.log(`Description: ${sample.description}`);
  console.log(`----------------------------------------------------------------`);

  const analysis = analyzeTable(sample.markdown)
  if (!analysis) {
    console.log(`[Analyzer] Table not recognized as plottable (rejected cleanly).`);
    return { id: sample.id, eligible: false, charted: false }
  }

  const deterministicPlan = planChart(analysis)
  if (!deterministicPlan) {
    console.log(`[Planner] Rejected by deterministic gates (prose or below minRows/worthCharting).`);
    return { id: sample.id, eligible: false, charted: false }
  }

  const needsJudge = shouldJudge(analysis, deterministicPlan)
  console.log(`[Gate Check] Deterministic kind: ${deterministicPlan.kind}, shouldJudge: ${needsJudge}`);

  if (!needsJudge) {
    console.log(`[Gate Check] Skipped judge call as table has <3 rows or <2 measures. Zero model calls spent.`);
    return { id: sample.id, eligible: true, judged: false, kind: deterministicPlan.kind }
  }

  const state = buildChartState(sample.markdown, analysis)
  const questions = buildChartQuestions(analysis, deterministicPlan)
  console.log(`[Questions] Built ${questions.length} questions: ${questions.map(q => q.id).join(', ')}`);

  const judgeQuestions: Record<string, any> = {}
  for (const q of questions) {
    judgeQuestions[q.id] = {
      type: 'choice',
      instructions: q.prompt,
      criteria: q.options,
    }
  }

  const res = await fetch('http://127.0.0.1:3425/v1/systemone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'group/decider',
      state,
      questions: judgeQuestions,
    }),
  })

  if (!res.ok) {
    console.log(`[Judge Error] Status ${res.status}: ${await res.text()}`);
    return { id: sample.id, error: res.status }
  }

  const result = await res.json()
  const rawAnswers: Record<string, { choice: string; confidence: number }> = {}
  for (const [id, a] of Object.entries(result.answers as Record<string, any>)) {
    if (a && a.type === 'choice' && typeof a.choice === 'string') {
      rawAnswers[id] = { choice: a.choice, confidence: a.confidence ?? 0 }
    }
  }

  const merged = mergeChartAnswers(deterministicPlan, analysis, rawAnswers)
  console.log(`[Merge Result] Final Kind: ${merged.plan.kind}`);
  console.log(`[Provenance] Model: ${result.model}, Usage: ${result.usage?.input_tokens ?? 0} tokens in`);
  console.log(`[Decisions & Trace Audit]:`);
  for (const e of merged.trace.entries) {
    console.log(
      `  - ${e.id.padEnd(8)}: adopted=${String(e.adopted).padEnd(5)} reason=${e.reason.padEnd(20)} before=${(e.before ?? '—').padEnd(14)} after=${(e.after ?? '—').padEnd(14)} conf=${(e.confidence ?? 0).toFixed(2)} / gate=${e.threshold.toFixed(2)}`
    )
  }

  const spec = buildSpec(analysis, merged.plan)
  console.log(`[Spec] Series count: ${spec?.series.length}, Categories: ${spec?.categories.length}`);

  return {
    id: sample.id,
    eligible: true,
    judged: true,
    preKind: deterministicPlan.kind,
    postKind: merged.plan.kind,
    adopted: merged.trace.adopted,
    ignored: merged.trace.ignored,
    trace: merged.trace.entries,
  }
}

console.log(`\n################################################################`);
console.log(`RUNNING TUNING DATASET (${data.tuning.length} samples)`);
console.log(`################################################################`);
for (const s of data.tuning) {
  await testSample(s)
}

console.log(`\n################################################################`);
console.log(`RUNNING HELDOUT DATASET (${data.heldout.length} samples)`);
console.log(`################################################################`);
for (const s of data.heldout) {
  await testSample(s)
}
