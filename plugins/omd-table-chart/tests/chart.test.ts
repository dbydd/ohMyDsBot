import { describe, expect, test } from 'bun:test'
import {
  analyzeTable,
  planChart,
  buildSpec,
  shouldJudge,
  mergeChartAnswers,
} from '../../omd-chart-plan/src/index.ts'
import { planTableTurnChart } from '../src/table.ts'
import type { JudgmentService } from '../src/types.ts'

describe('omd-table-chart regressions and invariants', () => {
  const tableWithMeasures = `| Model | Latency (ms) | Pass Rate | Cost ($) |
|---|---|---|---|
| Model Alpha | 120 | 85.0% | 0.05 |
| **Model Beta** | 95 | 92.5% | 0.12 |
| Model Gamma | 110 | 88.0% | 0.08 |
| Baseline | 150 | 78.0% | 0.04 |`

  const tableProse = `| Feature | Description | Status |
|---|---|---|
| Auth | Implements JWT token authentication and OAuth2 callbacks with refresh tokens | Completed |
| Storage | S3 compatible blob storage provider with local filesystem fallback | In Progress |`

  const tableSmall = `| Task | Duration |
|---|---|
| Build | 12s |
| Test | 45s |`

  const tableComposition = `| Service | Cached Tokens | Prompt Tokens | Completion Tokens | Total Tokens |
|---|---|---|---|---|
| Ingestion | 1200 | 800 | 400 | 2400 |
| Query Engine | 3500 | 1500 | 1000 | 6000 |
| Summarizer | 500 | 2000 | 1500 | 4000 |`

  test('mode=off returns undefined and makes 0 calls', async () => {
    let called = 0
    const mockJudge: JudgmentService = {
      available: () => { called++; return true },
      label: () => 'mock',
      judge: async () => { called++; throw new Error('should not call') },
    }
    const outcome = await planTableTurnChart(
      tableWithMeasures,
      { mode: 'off', minRows: 2, pickTimeoutMs: 5000, maxQuestions: 25, maxTableChars: 4000 },
      mockJudge,
    )
    expect(outcome).toBeUndefined()
    expect(called).toBe(0)
  })

  test('mode=heuristic makes 0 judge calls and returns decidedBy=heuristic', async () => {
    let called = 0
    const mockJudge: JudgmentService = {
      available: () => { called++; return true },
      label: () => 'mock',
      judge: async () => { called++; throw new Error('should not call') },
    }
    const outcome = await planTableTurnChart(
      tableWithMeasures,
      { mode: 'heuristic', minRows: 2, pickTimeoutMs: 5000, maxQuestions: 25, maxTableChars: 4000 },
      mockJudge,
    )
    expect(outcome).toBeDefined()
    expect(outcome?.outcome).toBe('resolved')
    expect(outcome?.decidedBy?.role).toBe('heuristic')
    expect(outcome?.trace).toBeUndefined()
    expect(called).toBe(0)
  })

  test('prose table is rejected cleanly by analyzer/planner', async () => {
    const outcome = await planTableTurnChart(
      tableProse,
      { mode: 'heuristic', minRows: 2, pickTimeoutMs: 5000, maxQuestions: 25, maxTableChars: 4000 },
      undefined,
    )
    expect(outcome).toBeUndefined()
  })

  test('small/ineligible table skips judge and uses heuristic plan with 0 model calls', async () => {
    let judgeCalls = 0
    const mockJudge: JudgmentService = {
      available: () => true,
      label: () => 'mock',
      judge: async () => { judgeCalls++; throw new Error('should not be called') },
    }
    // 3 rows with 1 measure is ineligible for judge (needs >=2 measures and >=3 rows):
    const tableOneMeasure = `| Step | Run Time (ms) |
|---|---|
| Step 1 | 120 |
| Step 2 | 150 |
| Step 3 | 110 |
| Step 4 | 140 |`
    const outcome = await planTableTurnChart(
      tableOneMeasure,
      { mode: 'judge', minRows: 2, pickTimeoutMs: 5000, maxQuestions: 25, maxTableChars: 4000 },
      mockJudge,
    )
    expect(outcome).toBeDefined()
    expect(outcome?.outcome).toBe('resolved')
    expect(outcome?.decidedBy?.role).toBe('heuristic')
    expect(judgeCalls).toBe(0)
  })

  test('unavailable judge fails cleanly with diagnostic hint', async () => {
    const mockJudge: JudgmentService = {
      available: () => false,
      label: () => 'none',
      judge: async () => { throw new Error('not available') },
    }
    const outcome = await planTableTurnChart(
      tableWithMeasures,
      { mode: 'judge', minRows: 2, pickTimeoutMs: 5000, maxQuestions: 25, maxTableChars: 4000 },
      mockJudge,
    )
    expect(outcome?.outcome).toBe('unavailable')
    expect(outcome?.hint?.scenario).toBe('unavailable_judge')
  })

  test('structural composition override survives judge choice of grouped', async () => {
    const analysis = analyzeTable(tableComposition)!
    const plan = planChart(analysis)!
    expect(plan.kind).toBe('stacked')

    // Judge votes for grouped and plot total column (c4):
    const answers = {
      kind: { choice: 'grouped', confidence: 0.8 },
      c1: { choice: 'yes', confidence: 0.9 },
      c2: { choice: 'yes', confidence: 0.9 },
      c3: { choice: 'yes', confidence: 0.9 },
      c4: { choice: 'yes', confidence: 0.9 },
    }
    const merged = mergeChartAnswers(plan, analysis, answers)
    expect(merged.plan.kind).toBe('stacked')
    expect(merged.plan.whole).toBe(4)
    expect(merged.plan.series).toEqual([1, 2, 3])

    const kindTrace = merged.trace.entries.find(e => e.id === 'kind')
    expect(kindTrace?.adopted).toBe(false)
    expect(kindTrace?.reason).toBe('structural-override')

    const c4Trace = merged.trace.entries.find(e => e.id === 'c4')
    expect(c4Trace?.adopted).toBe(false)
    expect(c4Trace?.reason).toBe('structural-override')
  })
})
