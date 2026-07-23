/**
 * AI 分析结果归一化。
 * 模型或自定义提示词偶尔会使用旧字段/近义字段，本模块把它们收敛为前端唯一契约，
 * 避免“模型已有结果但界面仍显示 0 分或空白”。
 */

const SCORE_DIMENSIONS = [
  { key: 'content_completeness', max: 20, aliases: ['completeness', 'content_score'] },
  { key: 'skill_match', max: 20, aliases: ['skill_score', 'skills_match', 'job_match'] },
  { key: 'project_quality', max: 30, aliases: ['experience_quality', 'experience_score', 'project_score'] },
  { key: 'resume_structure', max: 15, aliases: ['structure', 'structure_score'] },
  { key: 'format_quality', max: 15, aliases: ['format', 'format_score', 'formatting'] },
];

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

/** 数字字段允许模型返回数值字符串，但必须被限制在业务评分范围内。 */
function toBoundedInteger(value, min, max) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function pickValue(source, keys) {
  for (const key of keys) {
    if (hasOwn(source, key)) return source[key];
  }
  return undefined;
}

/** 兼容模型用逗号、顿号或换行返回列表，同时过滤空项和项目符号。 */
function toStringList(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[\n,，、；;]+/) : []);
  return raw
    .map((item) => String(item || '').replace(/^\s*(?:[-*•]+|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
}

/** 按各维度满分权重分配旧版总分，并使用最大余数法保证维度之和严格等于总分。 */
function allocateWeightedScore(total, dimensions) {
  const weighted = dimensions.map((dimension, index) => {
    const exact = total * dimension.max / 100;
    return { index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - weighted.reduce((sum, item) => sum + item.value, 0);
  weighted
    .slice()
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((item) => {
      if (remaining > 0) {
        weighted[item.index].value += 1;
        remaining -= 1;
      }
    });
  return weighted.map((item) => item.value);
}

/** 评分结果统一为五个维度；旧版仅有 score/reason 时保留原因并按既定权重折算维度。 */
function normalizeScoreResult(input) {
  const source = input?.data && typeof input.data === 'object'
    ? input.data
    : (input?.result && typeof input.result === 'object' ? input.result : (input || {}));
  const dimensionValues = SCORE_DIMENSIONS.map((dimension) => {
    const raw = pickValue(source, [dimension.key, ...dimension.aliases]);
    return toBoundedInteger(raw, 0, dimension.max);
  });
  const hasAnyDimension = dimensionValues.some((value) => value !== null);
  const reportedTotal = toBoundedInteger(
    pickValue(source, ['total', 'score', 'overall_score', 'match_score']),
    0,
    100,
  );

  let normalizedValues = dimensionValues;
  let legacyWeighted = false;
  if (!hasAnyDimension && reportedTotal !== null) {
    normalizedValues = allocateWeightedScore(reportedTotal, SCORE_DIMENSIONS);
    legacyWeighted = true;
  } else {
    normalizedValues = dimensionValues.map((value) => value ?? 0);
  }

  const result = {};
  SCORE_DIMENSIONS.forEach((dimension, index) => {
    result[dimension.key] = normalizedValues[index];
  });
  result.total = normalizedValues.reduce((sum, value) => sum + value, 0);
  result.summary = String(
    pickValue(source, ['summary', 'reason', 'analysis_summary', 'comment']) || '',
  ).trim();
  result.fallback_note = legacyWeighted
    ? '模型仅返回总分，五个维度已按既定满分权重折算。'
    : '';
  return result;
}

/** 岗位分析兼容常见字段别名与字符串列表，固定输出前端完整展示契约。 */
function normalizeJdMatchResult(input, jdText = '') {
  const source = input?.data && typeof input.data === 'object'
    ? input.data
    : (input?.result && typeof input.result === 'object' ? input.result : (input || {}));
  const matchScore = toBoundedInteger(
    pickValue(source, ['match_score', 'score', 'total', 'matching_score']),
    0,
    100,
  ) ?? 0;
  const keywords = toStringList(pickValue(source, ['keywords', 'job_keywords', 'position_keywords']));
  const suggestions = toStringList(pickValue(source, ['suggestions', 'optimization_suggestions', 'recommendations', 'advice']));
  const reason = String(pickValue(source, ['reason', 'analysis', 'summary']) || '').trim();

  // 简短岗位名称也应产生可见结果；只把用户原文作为关键词，不推断未提供的硬性要求。
  const conciseJd = String(jdText || '').trim();
  if (!keywords.length && conciseJd && conciseJd.length <= 30) keywords.push(conciseJd);
  if (!suggestions.length && reason) suggestions.push(reason);
  if (!suggestions.length) {
    suggestions.push('请在简历中补充与该岗位直接相关的真实职责、项目过程和可验证成果。');
  }

  return {
    match_score: matchScore,
    match_advantages: toStringList(pickValue(source, ['match_advantages', 'advantages', 'strengths', 'matched_requirements'])),
    position_gaps: toStringList(pickValue(source, ['position_gaps', 'gaps', 'weaknesses', 'requirement_gaps'])),
    experience_gap: String(pickValue(source, ['experience_gap', 'experience_difference', 'seniority_gap']) || '').trim(),
    keywords,
    missing_skills: toStringList(pickValue(source, ['missing_skills', 'skill_gaps', 'missing_requirements'])),
    suggestions,
  };
}

/**
 * 评分流可见内容过滤器。
 * 正常中文报告实时透传，内部 SCORE_JSON 与旧提示词直接返回的纯 JSON 始终留在服务端解析。
 */
function createScoreVisibleChunkHandler(onChunk) {
  let buffer = '';
  let hidden = false;
  let machineOnly = null;

  const write = (chunk) => {
    buffer += chunk;
    if (machineOnly === null) {
      const firstVisible = buffer.trimStart();
      if (!firstVisible) return;
      machineOnly = firstVisible.startsWith('{') || /^```(?:json)?/i.test(firstVisible);
    }
    if (machineOnly) {
      buffer = '';
      return;
    }

    let visible = '';
    while (buffer) {
      if (hidden) {
        const end = buffer.search(/<\/SCORE_JSON>/i);
        if (end === -1) {
          buffer = '';
          break;
        }
        buffer = buffer.slice(end).replace(/^<\/SCORE_JSON>/i, '');
        hidden = false;
        continue;
      }

      const start = buffer.search(/<SCORE_JSON>/i);
      if (start === -1) {
        // 保留短尾巴，避免 SCORE_JSON 标签恰好被上游 TCP 分块拆开后泄漏到界面。
        if (buffer.length <= 20) break;
        visible += buffer.slice(0, -20);
        buffer = buffer.slice(-20);
        break;
      }
      visible += buffer.slice(0, start);
      buffer = buffer.slice(start).replace(/^<SCORE_JSON>/i, '');
      hidden = true;
    }
    if (visible && typeof onChunk === 'function') onChunk(visible);
  };

  // 正常报告没有机器标签时也要冲刷保留尾部，避免最后一行被截断。
  write.flush = () => {
    if (!machineOnly && !hidden && buffer && typeof onChunk === 'function') onChunk(buffer);
    buffer = '';
  };
  return write;
}

module.exports = {
  SCORE_DIMENSIONS,
  normalizeScoreResult,
  normalizeJdMatchResult,
  createScoreVisibleChunkHandler,
};
