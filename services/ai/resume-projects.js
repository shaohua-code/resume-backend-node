/**
 * 从简历原文保守回填项目经历。
 * 不做整表重建：避免 pdf-parse 版面乱序时把职责/标题切错导致「提取错乱」。
 * 仅在高置信场景：补全过短 description，或补回明确漏掉的首条项目。
 */

/** 取出「项目经验/经历」正文，截到下一常见大模块标题前。 */
function sliceProjectSection(text = '') {
  const src = String(text || '')
  const startMatch = src.match(/项目经[验历]/)
  if (!startMatch || startMatch.index == null) return ''
  const rest = src.slice(startMatch.index + startMatch[0].length)
  const endMatch = rest.match(
    /\n\s*(?:工作经[验历]|教育背景|教育经历|实习经[验历]|专业技能|技能特长|自我评价|个人评价|荣誉奖项|证书资质|获奖情况|校园经历)/,
  )
  return endMatch ? rest.slice(0, endMatch.index) : rest
}

/** 标题行：短、非编号、不含简介/职责标签。 */
function isLikelyProjectTitle(line = '') {
  const text = String(line || '').trim()
  if (!text || text.length > 60) return false
  if (/项目简介|项目职责|项目经[验历]/.test(text)) return false
  if (/^\d+[\.、]/.test(text)) return false
  if (/^(?:负责|使用|基于|参与|完成)/.test(text)) return false
  return true
}

/**
 * 按「标题行 + 项目简介」切分；标题必须像真实项目名，否则丢弃该块。
 * @returns {{ name: string, description: string, tech_stack: string }[]}
 */
function extractProjectBlocksFromText(text = '') {
  const section = sliceProjectSection(text).replace(/\r\n/g, '\n')
  if (!section.trim()) return []

  const introRe = /项目简介\s*[:：]/g
  const matches = [...section.matchAll(introRe)]
  if (!matches.length) return []

  const blocks = []
  for (let i = 0; i < matches.length; i += 1) {
    const introIdx = matches[i].index
    const before = section.slice(0, introIdx)
    const lines = before.split('\n').map((item) => item.trim()).filter(Boolean)
    const title = lines.length ? lines[lines.length - 1] : ''
    if (!isLikelyProjectTitle(title)) continue

    const nextIntroIdx = i + 1 < matches.length ? matches[i + 1].index : section.length
    // 下一块标题：简介后到下一「项目简介」前的最后一行短标题
    let endIdx = nextIntroIdx
    if (i + 1 < matches.length) {
      const between = section.slice(introIdx, nextIntroIdx)
      const betweenLines = between.split('\n')
      for (let j = betweenLines.length - 1; j >= 0; j -= 1) {
        const line = String(betweenLines[j] || '').trim()
        if (isLikelyProjectTitle(line)) {
          // 截到该标题行之前，避免把下个项目名吃进 description
          const rel = between.lastIndexOf(line)
          if (rel >= 0) endIdx = introIdx + rel
          break
        }
      }
    }

    const description = section.slice(introIdx, endIdx).trim()
    if (!description || description.length < 8) continue
    // 无职责且极短，多半是噪声块
    if (!/项目职责/.test(description) && !/\n\s*1[\.、]/.test(description) && description.length < 30) {
      continue
    }

    blocks.push({
      name: title,
      description,
      tech_stack: extractTechFromBody(description),
    })
  }
  return blocks
}

/** 从职责第 1 条里尽量抽出技术栈文案。 */
function extractTechFromBody(body = '') {
  const text = String(body || '')
  const match = text.match(
    /(?:该项目)?(?:使用|采用)\s*([A-Za-z][A-Za-z0-9.++\-_/、，,\s]{5,160}?)(?:封装|负责|约束|控制|；|;|。|\n|$)/,
  )
  if (!match) return ''
  return String(match[1] || '')
    .replace(/\s+/g, '')
    .replace(/[，,、]/g, '+')
    .replace(/\++/g, '+')
    .replace(/^\+|\+$/g, '')
}

function normalizeNameKey(name = '') {
  return String(name || '')
    .replace(/[*＊\s]/g, '')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .toLowerCase()
}

function namesLooselyMatch(a = '', b = '') {
  const left = normalizeNameKey(a)
  const right = normalizeNameKey(b)
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

function findBestProjectMatch(list = [], name = '') {
  if (!name || !Array.isArray(list) || !list.length) return null
  return list.find((item) => namesLooselyMatch(item && item.name, name)) || null
}

function toProject(item = {}, fallback = {}) {
  return {
    name: item.name || fallback.name || '',
    role: item.role || fallback.role || '',
    description: item.description || fallback.description || '',
    tech_stack: item.tech_stack || fallback.tech_stack || '',
    start_date: item.start_date || item.startDate || fallback.start_date || '',
    end_date: item.end_date || item.endDate || fallback.end_date || '',
  }
}

/**
 * 保守回填：
 * 1) 保留模型项目顺序与条数为主；
 * 2) 仅当同名原文职责明显更完整时替换 description；
 * 3) 仅当原文首条完全不在模型结果中时，插入到最前。
 */
function enrichProjectsFromSource(sourceText, projects = []) {
  const aiList = Array.isArray(projects)
    ? projects.map((item) => toProject(item)).filter((item) => item.name || item.description || item.tech_stack)
    : []
  const blocks = extractProjectBlocksFromText(sourceText)
  if (!blocks.length) return aiList

  // 模型完全没抽到项目时，才用原文块兜底
  if (!aiList.length) {
    return blocks.map((block) => toProject(block))
  }

  const usedBlocks = new Set()
  const enriched = aiList.map((ai) => {
    const matched = findBestProjectMatch(
      blocks.filter((block) => !usedBlocks.has(block)),
      ai.name,
    )
    if (!matched) return ai
    usedBlocks.add(matched)

    const aiDesc = String(ai.description || '').trim()
    const blockDesc = String(matched.description || '').trim()
    // 同名命中后：原文含职责且明显更完整，或模型丢掉了职责列表时，用原文正文
    const sourceRicher = /项目职责/.test(blockDesc) && (
      blockDesc.length > aiDesc.length + 20
      || !/项目职责/.test(aiDesc)
    )

    return toProject({
      ...ai,
      // 名称仍以模型为准，避免原文 OCR/乱序标题覆盖正确名
      name: ai.name || matched.name,
      description: sourceRicher ? blockDesc : (aiDesc || blockDesc),
      tech_stack: ai.tech_stack || matched.tech_stack || '',
    })
  })

  // 只补「明确漏掉的首条」：原文第一项无法匹配到任一模型项目
  const firstBlock = blocks[0]
  const firstCovered = aiList.some((ai) => namesLooselyMatch(ai.name, firstBlock.name))
  if (!firstCovered && !usedBlocks.has(firstBlock)) {
    enriched.unshift(toProject(firstBlock))
  }

  return enriched
}

module.exports = {
  extractProjectBlocksFromText,
  enrichProjectsFromSource,
  sliceProjectSection,
}
