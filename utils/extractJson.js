/**
 * 从 AI 返回的文本中提取 JSON 对象。
 * 兼容 markdown 代码块、尾逗号、字符串内裸换行等常见瑕疵。
 * extractJson 解析失败仍返回 {}，保持历史调用兼容；
 * extractJsonSafe 可区分「解析失败」与「合法空对象」。
 */

/** 去掉 ```json ... ``` 或 ``` ... ``` 包裹，只保留内部文本。 */
function stripMarkdownFence(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/)
  if (fenced) return fenced[1].trim()
  // 模型偶发在前后夹杂说明文字，仍尝试剥离首个代码块。
  const embedded = raw.match(/```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```/)
  if (embedded) return embedded[1].trim()
  return raw
}

/** 截取第一个 { 到最后一个 } 的候选片段。 */
function sliceJsonCandidate(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}') + 1
  if (start === -1 || end <= start) return ''
  return text.slice(start, end)
}

/** 去掉对象/数组中的尾逗号，如 {"a":1,} 或 [1,]。 */
function removeTrailingCommas(jsonText) {
  return jsonText.replace(/,\s*([}\]])/g, '$1')
}

/**
 * 将 JSON 字符串字面量内部的裸换行转义为 \\n。
 * 只处理双引号字符串；已转义的 \" 与 \\ 保持不变。
 */
function escapeRawNewlinesInStrings(jsonText) {
  let result = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < jsonText.length; i += 1) {
    const ch = jsonText[i]
    if (inString) {
      if (escaped) {
        result += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        result += ch
        escaped = true
        continue
      }
      if (ch === '"') {
        result += ch
        inString = false
        continue
      }
      // 字符串内的真实换行会导致 JSON.parse 失败，统一转义。
      if (ch === '\n') {
        result += '\\n'
        continue
      }
      if (ch === '\r') {
        result += '\\r'
        continue
      }
      if (ch === '\t') {
        result += '\\t'
        continue
      }
      result += ch
      continue
    }
    if (ch === '"') {
      inString = true
    }
    result += ch
  }
  return result
}

/** 依次尝试直解析与轻量修复后再解析。 */
function tryParseJson(candidate) {
  if (!candidate) {
    return { ok: false, data: {}, reason: 'no_json' }
  }
  try {
    return { ok: true, data: JSON.parse(candidate), reason: '' }
  } catch {
    // 继续修复
  }
  try {
    const repaired = escapeRawNewlinesInStrings(removeTrailingCommas(candidate))
    return { ok: true, data: JSON.parse(repaired), reason: '' }
  } catch {
    return { ok: false, data: {}, reason: 'parse_error' }
  }
}

/**
 * 安全提取：可区分解析失败与合法空对象。
 * @param {string} text
 * @returns {{ ok: boolean, data: object, reason: string }}
 */
function extractJsonSafe(text) {
  const stripped = stripMarkdownFence(text)
  if (!stripped) {
    return { ok: false, data: {}, reason: 'empty' }
  }
  const candidate = sliceJsonCandidate(stripped)
  return tryParseJson(candidate)
}

/**
 * 兼容旧调用：成功返回对象，失败返回 {}。
 * @param {string} text AI 返回的原始文本
 * @returns {object}
 */
function extractJson(text) {
  const { data } = extractJsonSafe(text)
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

module.exports = { extractJson, extractJsonSafe, stripMarkdownFence }
