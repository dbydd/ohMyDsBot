/**
 * 程序化多库候选融合与词法锚点门禁（无 Judge 模式）。
 *
 * 1. Reciprocal Rank Fusion (RRF):
 *    解决跨库 raw score 不可比的问题。对每个 Bank 内的候选按 score 排序得到 rank，
 *    以 1 / (k + rank) 累加计算最终得分。
 *
 * 2. 词法锚点门禁 (Lexical Anchor Gate):
 *    关闭 judge 注入审查时，丢弃与当前查询没有任何共享实词锚点的候选。
 *    判据是「共享锚点个数」而不是比例：比例会被查询长度稀释（实测中文查询下
 *    相关事实的覆盖率也只有 0.07～0.29），个数则在长查询下保持稳定。
 *    锚点 = 长度 ≥3 的英文/数字词，或中文连续片段里的双字词。
 */

const ENGLISH_WORD = /[a-z0-9][a-z0-9_.-]{2,}/g;
const CJK_RUN = /[\u4e00-\u9fa5]+/g;

/** 只用于去掉「哪条事实都能撞上」的虚词锚点，不收录实词。 */
const STOP_TERMS: Readonly<Record<string, true>> = {
  the: true, and: true, for: true, with: true, that: true, this: true,
  from: true, are: true, was: true, were: true, you: true, your: true,
  not: true, but: true, can: true, has: true, have: true, had: true,
  用户: true, 如何: true, 什么: true, 怎么: true, 可以: true, 需要: true,
  我们: true, 你们: true, 这个: true, 那个: true, 一个: true, 这一: true,
  每一: true, 就是: true, 已经: true, 因为: true, 所以: true, 如果: true,
  还是: true,
};

export interface ScoredCandidate {
  readonly id: string;
  readonly bankId: string;
  readonly text: string;
  readonly score: number;
}

/**
 * 互易排名融合（Reciprocal Rank Fusion, RRF）。
 * @param candidates 各库召回的混合候选列表
 * @param k 平滑常数，标准 IR 惯例取 60
 */
export function reciprocalRankFusion<T extends ScoredCandidate>(
  candidates: readonly T[],
  k = 60,
): T[] {
  if (candidates.length <= 1) return [...candidates];

  const byBank = new Map<string, T[]>();
  for (const item of candidates) {
    let list = byBank.get(item.bankId);
    if (list === undefined) {
      list = [];
      byBank.set(item.bankId, list);
    }
    list.push(item);
  }

  const fused = new Map<string, number>();
  const items = new Map<string, T>();
  for (const list of byBank.values()) {
    list.sort((left, right) => right.score - left.score);
    list.forEach((item, index) => {
      const key = `${item.bankId}\u0000${item.id}`;
      items.set(key, item);
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }

  return [...fused.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([key]) => items.get(key) as T);
}

/** 抽取词法锚点：英文/数字词与中文双字词，去掉虚词。 */
export function extractAnchors(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const anchors = new Set<string>();
  for (const word of normalized.match(ENGLISH_WORD) ?? []) {
    if (STOP_TERMS[word] !== true) anchors.add(word);
  }
  for (const run of normalized.match(CJK_RUN) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (STOP_TERMS[bigram] !== true) anchors.add(bigram);
    }
  }
  return anchors;
}

/** 候选与查询共享的词法锚点个数。 */
export function sharedAnchorCount(query: string, candidateText: string): number {
  const queryAnchors = extractAnchors(query);
  if (queryAnchors.size === 0) return 0;
  const candidateAnchors = extractAnchors(candidateText);
  let shared = 0;
  for (const anchor of queryAnchors) {
    if (candidateAnchors.has(anchor)) shared += 1;
  }
  return shared;
}

/**
 * 程序化门禁：保留与查询共享至少 `minShared` 个锚点的候选。
 * `minShared <= 0` 表示不过滤。
 */
export function filterByAnchors<T extends { readonly text: string }>(
  candidates: readonly T[],
  query: string,
  minShared: number,
): T[] {
  if (!(minShared > 0) || candidates.length === 0) return [...candidates];
  return candidates.filter((candidate) => sharedAnchorCount(query, candidate.text) >= minShared);
}
