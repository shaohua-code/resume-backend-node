/**
 * 提示词解析：用户指令 → 管理员指令 → 代码默认；输出 Schema/格式段始终由代码锁定追加。
 * 无任何覆盖时直接使用完整代码 Prompt，保证与历史行为一致。
 */

const { dbAdmin } = require('../../dbClient')
const { AI_TASK } = require('./ai.model')
const { isUserPromptCustomizationEnabled } = require('./ai.featureFlags')
const {
  RESUME_GENERATE_PROMPT,
  LAZY_GENERATE_PROMPT,
  RESUME_EXTRACT_PROMPT,
  OPTIMIZE_PROJECT_PROMPT,
  OPTIMIZE_SUMMARY_PROMPT,
  OPTIMIZE_SKILLS_PROMPT,
  OPTIMIZE_INTERNSHIP_PROMPT,
  OPTIMIZE_WORK_EXPERIENCE_PROMPT,
  JD_MATCH_PROMPT,
  SCORE_PROMPT,
  SCORE_STREAM_PROMPT,
  PDF_OPTIMIZE_PROMPT,
  JD_RESUME_OPTIMIZE_PROMPT,
  PDF_JD_OPTIMIZE_PROMPT,
  JD_IMAGE_EXTRACT_PROMPT,
  CODE_DEFAULT_INSTRUCTIONS,
  composePrompt,
  COMMON_WRAPPED_RESUME_SCHEMA,
  COMMON_DIRECT_RESUME_OUTPUT,
  COMMON_WRAPPED_RESUME_OUTPUT,
  COMMON_JD_ALIGNMENT_RULES,
  COMMON_INPUT_BOUNDARY,
  COMMON_SCREENING_QUALITY_GATE,
  COMMON_FAIR_RECRUITING_RULES,
  format,
} = require('./ai.prompts')

const FULL_PROMPTS = {
  [AI_TASK.RESUME_GENERATE]: RESUME_GENERATE_PROMPT,
  lazy_generate: LAZY_GENERATE_PROMPT,
  [AI_TASK.RESUME_EXTRACT]: RESUME_EXTRACT_PROMPT,
  [AI_TASK.PROJECT_OPTIMIZE]: OPTIMIZE_PROJECT_PROMPT,
  [AI_TASK.SUMMARY_OPTIMIZE]: OPTIMIZE_SUMMARY_PROMPT,
  [AI_TASK.SKILLS_OPTIMIZE]: OPTIMIZE_SKILLS_PROMPT,
  [AI_TASK.INTERNSHIP_OPTIMIZE]: OPTIMIZE_INTERNSHIP_PROMPT,
  [AI_TASK.WORK_EXPERIENCE_OPTIMIZE]: OPTIMIZE_WORK_EXPERIENCE_PROMPT,
  [AI_TASK.JD_MATCH]: JD_MATCH_PROMPT,
  [AI_TASK.SCORE]: SCORE_PROMPT,
  score_stream: SCORE_STREAM_PROMPT,
  [AI_TASK.PDF_OPTIMIZE]: PDF_OPTIMIZE_PROMPT,
  [AI_TASK.JD_RESUME_OPTIMIZE]: JD_RESUME_OPTIMIZE_PROMPT,
  [AI_TASK.PDF_JD_OPTIMIZE]: PDF_JD_OPTIMIZE_PROMPT,
  [AI_TASK.JD_IMAGE_EXTRACT]: JD_IMAGE_EXTRACT_PROMPT,
}

/** 覆盖指令时追加的锁定尾段：含输入占位与输出契约，永不下发给前端 */
const LOCKED_TAILS = {
  // 输出包装约束放最前，避免管理员指令覆盖后模型仍输出扁平简历根对象
  [AI_TASK.RESUME_GENERATE]: composePrompt(
    COMMON_WRAPPED_RESUME_OUTPUT,
    COMMON_WRAPPED_RESUME_SCHEMA,
    COMMON_FAIR_RECRUITING_RULES,
    COMMON_INPUT_BOUNDARY,
    `## 用户信息\n<user_data>\n{user_input}\n</user_data>`,
    COMMON_SCREENING_QUALITY_GATE,
  ),
  lazy_generate: composePrompt(
    COMMON_WRAPPED_RESUME_OUTPUT,
    COMMON_WRAPPED_RESUME_SCHEMA,
    COMMON_FAIR_RECRUITING_RULES,
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<user_data>\n{user_input}\n</user_data>`,
    COMMON_SCREENING_QUALITY_GATE,
  ),
  [AI_TASK.RESUME_EXTRACT]: composePrompt(
    `## 输出JSON结构
根对象字段与标准简历 Schema 一致；internships/work_experiences 每项必须使用英文字段 company、position（及工作的 department），禁止中文键名；缺失字符串填""，缺失数组填[]；不得输出 null 或额外字段。
公司名若在原文出现（含经历首行「公司 | 职位 | 时间」），必须写入对应记录的 company。`,
    `## 输入数据\n<resume_source>\n{resume_source}\n</resume_source>`,
    COMMON_DIRECT_RESUME_OUTPUT,
  ),
  [AI_TASK.PROJECT_OPTIMIZE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<project_record>\n{project_record}\n</project_record>\n<resume_context>\n{resume_context}\n</resume_context>\n<project_description>\n{project_description}\n</project_description>`,
    `## 输出强制约束\n只输出可 JSON.parse 的对象：{"optimized":"","highlights":[]}。optimized 用 \\n 分隔要点。`,
  ),
  [AI_TASK.SUMMARY_OPTIMIZE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<summary>\n{summary}\n</summary>\n<resume_context>\n{resume_context}\n</resume_context>`,
    `## 输出强制约束\n只输出可 JSON.parse 的对象：{"optimized":""}。`,
  ),
  [AI_TASK.SKILLS_OPTIMIZE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<skills>\n{skills}\n</skills>\n<resume_context>\n{resume_context}\n</resume_context>`,
    `## 输出强制约束\n只输出可 JSON.parse 的对象：{"optimized":[]}，值为字符串数组。`,
  ),
  [AI_TASK.INTERNSHIP_OPTIMIZE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<internship_record>\n{internship_record}\n</internship_record>\n<resume_context>\n{resume_context}\n</resume_context>\n<original_description>\n{original_description}\n</original_description>`,
    `## 输出强制约束\n只输出可 JSON.parse 的对象：{"optimized":"","highlights":[]}。`,
  ),
  [AI_TASK.WORK_EXPERIENCE_OPTIMIZE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<work_record>\n{work_record}\n</work_record>\n<resume_context>\n{resume_context}\n</resume_context>\n<original_description>\n{original_description}\n</original_description>`,
    `## 输出强制约束\n只输出可 JSON.parse 的对象：{"optimized":"","highlights":[]}。`,
  ),
  [AI_TASK.JD_MATCH]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<resume_content>\n{resume_content}\n</resume_content>\n<jd_text>\n{jd_text}\n</jd_text>`,
    `## 输出强制约束\n只输出可 JSON.parse 的匹配分析结果对象，不得输出 markdown。`,
  ),
  [AI_TASK.SCORE]: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<resume_content>\n{resume_content}\n</resume_content>`,
    `## 输出强制约束\n只输出可 JSON.parse 的评分对象。`,
  ),
  score_stream: composePrompt(
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<resume_content>\n{resume_content}\n</resume_content>`,
    `## 输出强制约束\n只输出可 JSON.parse 的评分对象。`,
  ),
  [AI_TASK.PDF_OPTIMIZE]: composePrompt(
    COMMON_WRAPPED_RESUME_OUTPUT,
    COMMON_WRAPPED_RESUME_SCHEMA,
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<target_position>{target_position}</target_position>\n<resume_source>\n{pdf_text}\n</resume_source>`,
  ),
  [AI_TASK.JD_RESUME_OPTIMIZE]: composePrompt(
    // 事实优先规则锁定在尾段，管理员改业务文案也无法去掉「不能太虚假」约束
    COMMON_JD_ALIGNMENT_RULES,
    COMMON_WRAPPED_RESUME_OUTPUT,
    COMMON_WRAPPED_RESUME_SCHEMA,
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<job_description>\n{jd_text}\n</job_description>\n<resume_json>\n{resume_json}\n</resume_json>`,
  ),
  [AI_TASK.PDF_JD_OPTIMIZE]: composePrompt(
    COMMON_JD_ALIGNMENT_RULES,
    COMMON_WRAPPED_RESUME_OUTPUT,
    COMMON_WRAPPED_RESUME_SCHEMA,
    COMMON_INPUT_BOUNDARY,
    `## 输入数据\n<job_description>\n{jd_text}\n</job_description>\n<resume_source>\n{pdf_text}\n</resume_source>`,
  ),
  [AI_TASK.JD_IMAGE_EXTRACT]: composePrompt(
    `## 输出强制约束\n仅输出提取到的纯文本，不要 JSON、markdown 代码块或解释。`,
  ),
}

function getCodeDefaultInstruction(taskType) {
  return CODE_DEFAULT_INSTRUCTIONS[taskType] || ''
}

async function getAdminInstruction(taskType) {
  const { data } = await dbAdmin
    .from('ai_task_prompt')
    .select('instruction')
    .eq('task_type', taskType)
    .maybeSingle()
  const text = String(data?.instruction || '').trim()
  return text || ''
}

async function getUserInstruction(userId, taskType) {
  if (!userId) return ''
  const enabled = await isUserPromptCustomizationEnabled()
  if (!enabled) return ''
  const { data } = await dbAdmin
    .from('user_ai_task_prompt')
    .select('instruction')
    .eq('user_id', userId)
    .eq('task_type', taskType)
    .maybeSingle()
  return String(data?.instruction || '').trim()
}

/**
 * 解析最终 Prompt 模板（含占位符），再由调用方 format。
 * @param {string} taskType
 * @param {{ userId?: string, promptKey?: string }} options promptKey 用于 lazy_generate / score_stream 等别名
 */
async function resolvePromptTemplate(taskType, options = {}) {
  const key = options.promptKey || taskType
  const userInstruction = await getUserInstruction(options.userId, taskType)
  const adminInstruction = userInstruction ? '' : await getAdminInstruction(taskType)
  // 用户覆盖优先；否则管理员；都没有则走完整代码 Prompt
  const override = userInstruction || adminInstruction
  if (override) {
    const locked = LOCKED_TAILS[key] || LOCKED_TAILS[taskType] || COMMON_DIRECT_RESUME_OUTPUT
    return composePrompt(override, locked)
  }
  return FULL_PROMPTS[key] || FULL_PROMPTS[taskType] || ''
}

async function resolveFormattedPrompt(taskType, vars, options = {}) {
  const tpl = await resolvePromptTemplate(taskType, options)
  return format(tpl, vars || {})
}

/**
 * 供 API 展示的生效指令（永不含 locked tail / Schema）
 */
async function resolveDisplayInstruction(taskType, userId, { allowUser = true } = {}) {
  if (allowUser && userId) {
    const userInstruction = await getUserInstruction(userId, taskType)
    if (userInstruction) {
      return { instruction: userInstruction, source: 'user' }
    }
  }
  const adminInstruction = await getAdminInstruction(taskType)
  if (adminInstruction) {
    return { instruction: adminInstruction, source: 'admin' }
  }
  return { instruction: getCodeDefaultInstruction(taskType), source: 'code' }
}

module.exports = {
  getCodeDefaultInstruction,
  resolvePromptTemplate,
  resolveFormattedPrompt,
  resolveDisplayInstruction,
  FULL_PROMPTS,
}
