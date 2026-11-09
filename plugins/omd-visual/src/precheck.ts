/**
 * Deterministic pre-screen for an explicit visualization request.
 *
 * The model is never asked this question: a human who says "画个图" has already
 * decided, so the trigger is a lexical test over the human message. A missed
 * request costs the picture — there is no manual command to fall back on — while
 * a false positive spends a child run and leaves a status card behind.
 *
 * Negation is a local window rather than a sentence parse: "不用画图" and "don't
 * draw anything" suppress the term that follows, which is the only shape a
 * negated request takes in practice.
 *
 * @module omd-visual/precheck
 */

/** Terms whose presence means the author asked for a picture. */
const REQUEST_TERMS: readonly RegExp[] = [
  // 画图 / 画个图 / 画一张图 / 画出来
  /画(?:一|个|张|下|出)?(?:图|表)/u,
  /绘制|画出/u,
  /可视化/u,
  // 示意图 / 流程图 / 架构图 / 关系图 / 时序图 / 思维导图
  /(?:示意|流程|架构|关系|时序|思维导|层级)图/u,
  /对比表|图表/u,
  /\b(?:draw|plot|sketch|visuali[sz]e)\b/iu,
  /\b(?:diagram|flow ?chart|mind ?map|comparison table)\b/iu,
]

/** Negations that cancel a term when they sit immediately before it. */
const NEGATIONS_ZH = /(?:不用|不需要|没必要|不必|不要|不用再|别|勿|无需|先不|暂时不|先别)/u
/** English negations, matched as whole words inside the same short window. */
const NEGATIONS_EN = /\b(?:no need to|don't|do not|not|without|never|instead of)\b/iu

/** How far back a Chinese negation still governs the term it precedes. */
const WINDOW_ZH = 10
/** How far back an English negation still governs. */
const WINDOW_EN = 24

/**
 * Whether a term at `index` is inside a negation's scope.
 * @param text - the whole message.
 * @param index - offset of the matched term.
 * @returns whether the nearest preceding window carries a negation.
 */
function negated(text: string, index: number): boolean {
  const zh = text.slice(Math.max(0, index - WINDOW_ZH), index)
  if (NEGATIONS_ZH.test(zh)) return true
  const en = text.slice(Math.max(0, index - WINDOW_EN), index)
  return NEGATIONS_EN.test(en)
}

/**
 * Whether one human message asks for a visualization.
 *
 * A message with no term, or whose every term is negated, is not a request.
 * @param text - the newest user message, verbatim.
 * @returns `true` when the message explicitly asks for a picture.
 */
export function asksForVisual(text: string): boolean {
  for (const term of REQUEST_TERMS) {
    const pattern = new RegExp(term.source, term.flags.includes('g') ? term.flags : `${term.flags}g`)
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue
      if (!negated(text, match.index)) return true
    }
  }
  return false
}
