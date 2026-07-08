/**
 * AI 服务模块
 * 封装所有与 DeepSeek API 交互的功能：
 * 1. AI 简历生成
 * 2. AI 项目/个人评价/技能/实习优化
 * 3. JD 岗位匹配
 * 4. AI 简历评分
 * 5. PDF 简历整体优化
 */

const axios = require('axios');
const { settings } = require('../../config');
const { calcAiCost, normalizeUsage } = require('../../utils/ai_cost');
const { extractJson } = require('../../utils/extractJson');
const { AI_TASK, resolveModel } = require('./ai.model');
const {
  RESUME_GENERATE_PROMPT,
  LAZY_GENERATE_PROMPT,
  OPTIMIZE_PROJECT_PROMPT,
  OPTIMIZE_SUMMARY_PROMPT,
  OPTIMIZE_SKILLS_PROMPT,
  OPTIMIZE_INTERNSHIP_PROMPT,
  JD_MATCH_PROMPT,
  SCORE_PROMPT,
  PDF_OPTIMIZE_PROMPT,
  format,
} = require('./ai.prompts');

// 组装调用元信息，供 recordAiCall 写入审计表
async function buildMeta(model, usage) {
  const normalizedUsage = normalizeUsage(usage);
  const cost = await calcAiCost(model, normalizedUsage);
  return { model, usage: normalizedUsage, cost };
}

/**
 * 调用 DeepSeek API 的通用方法（非流式）
 * @returns {Promise<{ content: string, usage: object, model: string, cost: number }>}
 */
async function callDeepseek(prompt, options = {}) {
  if (!settings.DEEPSEEK_API_KEY || !settings.DEEPSEEK_API_KEY.trim()) {
    const err = new Error(
      'DeepSeek API Key 未配置！请在 .env 文件中设置 DEEPSEEK_API_KEY=你的密钥。' +
        '获取地址：https://platform.deepseek.com/api_keys',
    );
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const headers = {
    Authorization: `Bearer ${settings.DEEPSEEK_API_KEY.trim()}`,
    'Content-Type': 'application/json',
  };
  const model = resolveModel(options.task, options.model);
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
  };
  const response = await axios.post(settings.DEEPSEEK_API_URL, payload, {
    headers,
    timeout: 60000,
  });
  const usage = normalizeUsage(response.data.usage || {});
  const cost = await calcAiCost(model, usage);
  return {
    content: response.data.choices[0].message.content,
    usage,
    model,
    cost,
  };
}

/**
 * 流式调用 DeepSeek API - 通过 onChunk 回调推送增量文本
 * @returns {Promise<{ content: string, usage: object, model: string, cost: number }>}
 */
async function callDeepseekStream(prompt, options = {}, onChunk) {
  if (!settings.DEEPSEEK_API_KEY || !settings.DEEPSEEK_API_KEY.trim()) {
    const err = new Error(
      'DeepSeek API Key 未配置！请在 .env 文件中设置 DEEPSEEK_API_KEY=你的密钥。' +
        '获取地址：https://platform.deepseek.com/api_keys',
    );
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const headers = {
    Authorization: `Bearer ${settings.DEEPSEEK_API_KEY.trim()}`,
    'Content-Type': 'application/json',
  };
  const model = resolveModel(options.task, options.model);
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  const response = await axios.post(settings.DEEPSEEK_API_URL, payload, {
    headers,
    timeout: 120000,
    responseType: 'stream',
  });

  return new Promise((resolve, reject) => {
    let full = '';
    let remainder = '';
    let usage = {};

    response.data.on('data', (chunk) => {
      remainder += chunk.toString();
      const lines = remainder.split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            usage = parsed.usage;
          }
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            full += content;
            if (typeof onChunk === 'function') onChunk(content, full);
          }
        } catch (e) {
          /* ignore partial json */
        }
      }
    });

    response.data.on('end', async () => {
      const meta = await buildMeta(model, usage);
      resolve({ content: full, ...meta });
    });
    response.data.on('error', reject);
  });
}

// ========== 简历数据规范化工具 ==========

function joinTechStack(techStack) {
  if (Array.isArray(techStack)) {
    return techStack.filter(Boolean).join('、');
  }
  return techStack || '';
}

function normalizeEducation(education) {
  if (Array.isArray(education)) {
    return education[0] || {};
  }
  if (education && typeof education === 'object') {
    return education;
  }
  return { degree: typeof education === 'string' ? education : '' };
}

function normalizeProject(project) {
  return {
    name: project.name || '',
    role: project.role || '',
    description: project.description || '',
    tech_stack: joinTechStack(project.tech_stack),
    start_date: project.start_date || '',
    end_date: project.end_date || '',
  };
}

function normalizeInternship(internship) {
  return {
    company: internship.company || '',
    position: internship.position || '',
    description: internship.description || '',
    start_date: internship.start_date || '',
    end_date: internship.end_date || '',
  };
}

function normalizePdfResume(data) {
  const source = data.resume && typeof data.resume === 'object' ? data.resume : data;
  const education = normalizeEducation(source.education);

  return {
    name: source.name || '',
    target_position: source.target_position || source.targetPosition || '',
    school: source.school || education.school || '',
    major: source.major || education.major || '',
    education: source.degree || education.degree || source.education_text || '',
    phone: source.phone || '',
    email: source.email || '',
    summary: source.summary || '',
    skills: Array.isArray(source.skills) ? source.skills.filter(Boolean) : [],
    projects: Array.isArray(source.projects) ? source.projects.map(normalizeProject) : [],
    internships: Array.isArray(source.internships) ? source.internships.map(normalizeInternship) : [],
    awards: Array.isArray(source.awards) ? source.awards.filter(Boolean) : [],
    certificates: Array.isArray(source.certificates) ? source.certificates.filter(Boolean) : [],
    avatar: source.avatar || '',
  };
}

function hasResumeContent(resume) {
  return Boolean(
    resume.name ||
      resume.phone ||
      resume.email ||
      resume.summary ||
      resume.school ||
      resume.projects.length ||
      resume.internships.length ||
      resume.skills.length ||
      resume.awards.length ||
      resume.certificates.length,
  );
}

/**
 * 将简历对象压缩为上下文文本，供优化 Prompt 使用
 * @param {object} resume
 * @returns {string}
 */
function buildResumeContext(resume) {
  const data = resume || {};
  const parts = [];
  parts.push(`姓名：${data.name || ''}`);
  parts.push(`目标岗位：${data.target_position || ''}`);
  parts.push(`学校：${data.school || ''} ${data.major || ''} ${data.education || ''}`);
  if (Array.isArray(data.skills) && data.skills.length) {
    parts.push(`技能：${data.skills.join('、')}`);
  }
  if (Array.isArray(data.projects) && data.projects.length) {
    const projText = data.projects.map((p) => {
      const tech = Array.isArray(p.tech_stack) ? p.tech_stack.join('、') : p.tech_stack || '';
      return `- ${p.name || '未命名'}（${p.role || ''}）${tech ? `[${tech}]` : ''}：${p.description || ''}`;
    }).join('\n');
    parts.push(`项目经历：\n${projText}`);
  }
  if (Array.isArray(data.internships) && data.internships.length) {
    const internText = data.internships.map((i) => {
      return `- ${i.company || ''}（${i.position || ''}）：${i.description || ''}`;
    }).join('\n');
    parts.push(`实习经历：\n${internText}`);
  }
  parts.push(`个人评价：${data.summary || ''}`);
  return parts.join('\n');
}

// ========== Prompt 组装 ==========

function resolveGeneratePrompt(bodyOrString, options = {}) {
  const isLazy = options.inputMode === 'lazy';
  if (isLazy) {
    const body = typeof bodyOrString === 'object' ? bodyOrString : {};
    const rawText = body.raw_text || (typeof bodyOrString === 'string' ? bodyOrString : '');
    const targetPosition = body.target_position || '';
    return format(LAZY_GENERATE_PROMPT, {
      user_input: rawText,
      target_position: targetPosition || '未指定',
    });
  }
  const userInput = typeof bodyOrString === 'string'
    ? bodyOrString
    : JSON.stringify(bodyOrString);
  return format(RESUME_GENERATE_PROMPT, { user_input: userInput });
}

// ========== 对外服务方法 ==========

/**
 * AI 生成简历（非流式）
 */
async function generateResume(userInput, options = {}) {
  const prompt = resolveGeneratePrompt(userInput, options);
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.RESUME_GENERATE, model: options.model });
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式 AI 生成简历
 */
async function generateResumeStream(userInput, options = {}, onChunk) {
  const prompt = resolveGeneratePrompt(userInput, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.RESUME_GENERATE, model: options.model },
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * AI 优化项目经历描述（非流式）
 */
async function optimizeProject(projectDescription, targetPosition = '', options = {}) {
  const prompt = format(OPTIMIZE_PROJECT_PROMPT, {
    project_description: projectDescription,
    target_position: targetPosition || '通用技术岗位',
    resume_context: '',
  });
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.PROJECT_OPTIMIZE, model: options.model });
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化项目经历描述
 */
async function optimizeProjectStream(project, resume, targetPosition = '', options = {}, onChunk) {
  const prompt = format(OPTIMIZE_PROJECT_PROMPT, {
    project_description: project.description || '',
    target_position: targetPosition || '通用技术岗位',
    resume_context: buildResumeContext(resume),
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.PROJECT_OPTIMIZE, model: options.model },
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化个人评价
 */
async function optimizeSummaryStream(resume, targetPosition = '', options = {}, onChunk) {
  const prompt = format(OPTIMIZE_SUMMARY_PROMPT, {
    target_position: targetPosition || '通用技术岗位',
    resume_context: buildResumeContext(resume),
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.SUMMARY_OPTIMIZE, model: options.model },
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化技能特长
 */
async function optimizeSkillsStream(resume, targetPosition = '', options = {}, onChunk) {
  const prompt = format(OPTIMIZE_SKILLS_PROMPT, {
    target_position: targetPosition || '通用技术岗位',
    skills: Array.isArray(resume.skills) ? resume.skills.join('、') : '',
    resume_context: buildResumeContext(resume),
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.SKILLS_OPTIMIZE, model: options.model },
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化实习经历描述
 */
async function optimizeInternshipStream(internship, resume, targetPosition = '', options = {}, onChunk) {
  const prompt = format(OPTIMIZE_INTERNSHIP_PROMPT, {
    internship_description: internship.description || '',
    target_position: targetPosition || '通用技术岗位',
    resume_context: buildResumeContext(resume),
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.INTERNSHIP_OPTIMIZE, model: options.model },
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * JD 岗位匹配分析
 */
async function matchJd(resumeContent, jdText, options = {}) {
  const prompt = format(JD_MATCH_PROMPT, { resume_content: resumeContent, jd_text: jdText });
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.JD_MATCH, model: options.model });
  const parsed = extractJson(content);
  return {
    data: {
      match_score: parsed.match_score || 0,
      keywords: parsed.keywords || [],
      missing_skills: parsed.missing_skills || [],
      suggestions: parsed.suggestions || [],
    },
    meta: { model, usage, cost },
  };
}

/**
 * AI 简历评分
 */
async function scoreResume(resumeContent, options = {}) {
  const prompt = format(SCORE_PROMPT, { resume_content: resumeContent });
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.SCORE, model: options.model });
  const parsed = extractJson(content);
  return {
    data: {
      content_completeness: parsed.content_completeness || 0,
      skill_match: parsed.skill_match || 0,
      project_quality: parsed.project_quality || 0,
      resume_structure: parsed.resume_structure || 0,
      format_quality: parsed.format_quality || 0,
      total: parsed.total || 0,
    },
    meta: { model, usage, cost },
  };
}

/**
 * 基于 PDF 文本整体优化简历（非流式）
 */
async function optimizeFromPdfText(pdfText, targetPosition = '', options = {}) {
  const prompt = format(PDF_OPTIMIZE_PROMPT, {
    pdf_text: pdfText,
    target_position: targetPosition || '通用职业方向',
  });
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.PDF_OPTIMIZE, model: options.model });
  const parsed = extractJson(content);
  if (!parsed || Object.keys(parsed).length === 0) {
    return { data: { resume: {}, optimization_notes: [] }, meta: { model, usage, cost } };
  }
  const resume = normalizePdfResume(parsed);
  return {
    data: {
      resume: hasResumeContent(resume) ? resume : {},
      optimization_notes: parsed.optimization_notes || parsed.resume?.optimization_notes || [],
    },
    meta: { model, usage, cost },
  };
}

/**
 * 流式 PDF 简历优化
 */
async function optimizeFromPdfTextStream(pdfText, targetPosition = '', options = {}, onChunk) {
  const prompt = format(PDF_OPTIMIZE_PROMPT, {
    pdf_text: pdfText,
    target_position: targetPosition || '通用职业方向',
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.PDF_OPTIMIZE, model: options.model },
    onChunk,
  );
  const parsed = extractJson(content);
  if (!parsed || Object.keys(parsed).length === 0) {
    return { data: { resume: {}, optimization_notes: [] }, meta: { model, usage, cost } };
  }
  const resume = normalizePdfResume(parsed);
  return {
    data: {
      resume: hasResumeContent(resume) ? resume : {},
      optimization_notes: parsed.optimization_notes || parsed.resume?.optimization_notes || [],
    },
    meta: { model, usage, cost },
  };
}

module.exports = {
  generateResume,
  generateResumeStream,
  optimizeProject,
  optimizeProjectStream,
  optimizeSummaryStream,
  optimizeSkillsStream,
  optimizeInternshipStream,
  matchJd,
  scoreResume,
  optimizeFromPdfText,
  optimizeFromPdfTextStream,
};
