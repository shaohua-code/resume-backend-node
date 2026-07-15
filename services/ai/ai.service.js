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
  // 工作经历（正式全职）优化 Prompt
  OPTIMIZE_WORK_EXPERIENCE_PROMPT,
  JD_MATCH_PROMPT,
  SCORE_PROMPT,
  PDF_OPTIMIZE_PROMPT,
  JD_RESUME_OPTIMIZE_PROMPT,
  PDF_JD_OPTIMIZE_PROMPT,
  JD_IMAGE_EXTRACT_PROMPT,
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

/**
 * 多模态视觉调用：从图片提取文本（非流式）
   * 优先使用阿里云 DashScope 视觉模型（Qwen3.6-Flash），降级到 DeepSeek
 * @param {Buffer} imageBuffer 图片二进制
 * @param {string} mimeType 如 image/jpeg
 */
async function callDeepseekVision(imageBuffer, mimeType, textPrompt, options = {}) {
  // 优先 DashScope 视觉模型，降级到 DeepSeek
  const dashscopeKey = (settings.DASHSCOPE_API_KEY || '').trim();
  const apiKey = dashscopeKey || (settings.DEEPSEEK_API_KEY || '').trim();
  const apiUrl = dashscopeKey ? settings.DASHSCOPE_API_URL : settings.DEEPSEEK_API_URL;
  if (!apiKey) {
    const err = new Error('视觉模型 API Key 未配置（DASHSCOPE_API_KEY 或 DEEPSEEK_API_KEY）');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const model = resolveModel(options.task, options.model);
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const payload = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: textPrompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    temperature: 0.3,
    max_tokens: 4096,
  };
  const response = await axios.post(apiUrl, payload, {
    headers,
    timeout: 90000,
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

// ========== 简历数据规范化工具 ==========

function joinTechStack(techStack) {
  if (Array.isArray(techStack)) {
    return techStack.filter(Boolean).join('、');
  }
  return techStack || '';
}

function normalizeEducationItem(item = {}) {
  return {
    school: item.school || '',
    major: item.major || '',
    main_course: item.main_course || item.mainCourse || '',
    degree: item.degree || item.education || '',
    start_date: item.start_date || '',
    end_date: item.end_date || '',
  };
}

function normalizeCustomField(item = {}) {
  return {
    label: (item.label || '').trim(),
    value: (item.value || '').trim(),
  };
}

/**
 * 归一化教育背景数组，兼容 educations[] / education[] 与扁平 school/major/education
 */
function normalizeEducations(source = {}) {
  const list = source.educations || source.education_list || [];

  if (Array.isArray(list) && list.length) {
    return list
      .map(normalizeEducationItem)
      .filter((item) => item.school || item.major || item.main_course || item.degree || item.start_date || item.end_date);
  }

  if (Array.isArray(source.education) && source.education.length) {
    return source.education
      .map(normalizeEducationItem)
      .filter((item) => item.school || item.major || item.main_course || item.degree || item.start_date || item.end_date);
  }

  if (source.school || source.major || source.main_course || source.mainCourse || source.education || source.degree) {
    return [normalizeEducationItem({
      school: source.school,
      major: source.major,
      main_course: source.main_course || source.mainCourse,
      degree: source.education || source.degree,
    })];
  }

  return [];
}

/** 归一化自定义键值对 */
function normalizeCustomFields(source = {}) {
  const list = source.custom_fields || source.customFields || [];
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeCustomField)
    .filter((item) => item.label && item.value);
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

/**
 * 从 AI 返回数据中提取目标岗位（兼容多种字段命名）
 * 优先级：标准英文字段 > camelCase 变体 > 中文直译字段 > 通用岗位字段
 * @param {Object} source AI 原始返回数据
 * @returns {string} 目标岗位字符串
 */
function extractTargetPosition(source) {
  return (
    source.target_position ||
    source.targetPosition ||
    source['意向岗位'] ||
    source['求职岗位'] ||
    source['面试岗位'] ||
    source['应聘岗位'] ||
    source.position ||
    source.job_title ||
    source.jobTitle ||
    ''
  );
}

function normalizePdfResume(data) {
  const source = data.resume && typeof data.resume === 'object' ? data.resume : data;
  const educations = normalizeEducations(source);
  const firstEdu = educations[0] || normalizeEducation(source.education);
  const customFields = normalizeCustomFields(source);

  return {
    name: source.name || '',
    // 使用统一提取函数兼容多种岗位字段命名
    target_position: extractTargetPosition(source),
    phone: source.phone || '',
    email: source.email || '',
    summary: source.summary || '',
    avatar: source.avatar || '',
    work_years: source.work_years || source.workYears || '',
    marital_status: source.marital_status || source.maritalStatus || '',
    height: source.height || '',
    weight: source.weight || '',
    ethnicity: source.ethnicity || '',
    native_place: source.native_place || source.nativePlace || source.origin || '',
    political_status: source.political_status || source.politicalStatus || '',
    expected_salary: source.expected_salary || source.expectedSalary || source.salary || '',
    custom_fields: customFields,
    educations,
    school: source.school || firstEdu.school || '',
    major: source.major || firstEdu.major || '',
    main_course: source.main_course || source.mainCourse || firstEdu.main_course || '',
    education: source.education || firstEdu.degree || source.degree || '',
    skills: Array.isArray(source.skills) ? source.skills.filter(Boolean) : [],
    projects: Array.isArray(source.projects) ? source.projects.map(normalizeProject) : [],
    internships: Array.isArray(source.internships) ? source.internships.map(normalizeInternship) : [],
    // 工作经历（正式全职工作，区别于实习）
    work_experiences: Array.isArray(source.work_experiences)
      ? source.work_experiences.map((w) => ({
          company: w.company || '',
          position: w.position || '',
          department: w.department || '',
          description: w.description || '',
          start_date: w.start_date || '',
          end_date: w.end_date || '',
        }))
      : [],
    awards: Array.isArray(source.awards) ? source.awards.filter(Boolean) : [],
    certificates: Array.isArray(source.certificates) ? source.certificates.filter(Boolean) : [],
  };
}

function hasResumeContent(resume) {
  return Boolean(
    resume.name ||
      resume.phone ||
      resume.email ||
      resume.summary ||
      resume.school ||
      (Array.isArray(resume.educations) && resume.educations.length) ||
      (Array.isArray(resume.projects) && resume.projects.length) ||
      (Array.isArray(resume.internships) && resume.internships.length) ||
      (Array.isArray(resume.work_experiences) && resume.work_experiences.length) ||
      (Array.isArray(resume.skills) && resume.skills.length) ||
      (Array.isArray(resume.awards) && resume.awards.length) ||
      (Array.isArray(resume.certificates) && resume.certificates.length),
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
  if (data.work_years) parts.push(`工作年限：${data.work_years}`);
  if (data.expected_salary) parts.push(`期望薪资：${data.expected_salary}`);

  const educations = normalizeEducations(data);
  if (educations.length) {
    const eduText = educations.map((e) => {
      const range = [e.start_date, e.end_date].filter(Boolean).join('~');
      return `- ${e.school || ''} ${e.major || ''} ${e.main_course || ''} ${e.degree || ''}${range ? `（${range}）` : ''}`;
    }).join('\n');
    parts.push(`教育背景：\n${eduText}`);
  } else {
    parts.push(`学校：${data.school || ''} ${data.major || ''} ${data.main_course || data.mainCourse || ''} ${data.education || ''}`);
  }

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
  // 工作经历（正式全职工作）
  if (Array.isArray(data.work_experiences) && data.work_experiences.length) {
    const workText = data.work_experiences.map((w) => {
      const dept = w.department ? `[${w.department}]` : '';
      return `- ${w.company || ''}${dept}（${w.position || ''}）${w.start_date || ''}~${w.end_date || ''}：${w.description || ''}`;
    }).join('\n');
    parts.push(`工作经历：\n${workText}`);
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
    target_position: targetPosition || '通用职业方向',
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
    target_position: targetPosition || '通用职业方向',
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
    target_position: targetPosition || '通用职业方向',
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
    target_position: targetPosition || '通用职业方向',
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
    target_position: targetPosition || '通用职业方向',
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
 * 工作经历（正式全职）AI 流式优化
 * 基于已填写的工作描述，使用 STAR 法则优化为更专业的表述
 * @param {object} workExp 单条工作经历对象
 * @param {object} resume 完整简历对象（用于构建上下文）
 * @param {string} targetPosition 目标岗位
 * @param {object} options 模型等配置
 * @param {function} onChunk 流式回调
 */
async function optimizeWorkExperienceStream(workExp, resume, targetPosition = '', options = {}, onChunk) {
  // 使用工作经历专用 Prompt（区别于实习，强调职业深度和业务价值）
  const prompt = format(OPTIMIZE_WORK_EXPERIENCE_PROMPT, {
    work_experience_description: workExp.description || '',
    target_position: targetPosition || '通用职业方向',
    resume_context: buildResumeContext(resume),
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.WORK_EXPERIENCE_OPTIMIZE, model: options.model },
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
 * 从 JD 图片中提取岗位描述文本（OCR/视觉模型）
 */
async function extractJdFromImage(imageBuffer, mimeType = 'image/jpeg', options = {}) {
  const { content, usage, model, cost } = await callDeepseekVision(
    imageBuffer,
    mimeType,
    JD_IMAGE_EXTRACT_PROMPT,
    { task: AI_TASK.JD_IMAGE_EXTRACT, model: options.model },
  );
  const jdText = String(content || '').trim();
  return {
    data: { jd_text: jdText },
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

/**
 * 基于 PDF 原文 + 岗位 JD 流式优化简历（Upload 模式）
 */
async function optimizePdfByJdStream(pdfText, jdText = '', options = {}, onChunk) {
  const prompt = format(PDF_JD_OPTIMIZE_PROMPT, {
    pdf_text: pdfText || '',
    jd_text: jdText || '',
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.PDF_JD_OPTIMIZE, model: options.model },
    onChunk,
  );
  const parsed = extractJson(content);
  if (!parsed || Object.keys(parsed).length === 0) {
    return { data: { resume: {}, optimization_notes: [] }, meta: { model, usage, cost } };
  }
  const rawResume = parsed.resume && typeof parsed.resume === 'object' ? parsed.resume : parsed;
  const resume = normalizePdfResume(rawResume);
  return {
    data: {
      resume: hasResumeContent(resume) ? resume : {},
      optimization_notes: parsed.optimization_notes || [],
    },
    meta: { model, usage, cost },
  };
}

/**
 * 基于岗位 JD 流式优化整份简历
 * @param {object} resumeJson 当前简历对象
 * @param {string} jdText 岗位 JD 文本
 */
async function optimizeResumeByJdStream(resumeJson, jdText = '', options = {}, onChunk) {
  const resumeStr = typeof resumeJson === 'string' ? resumeJson : JSON.stringify(resumeJson || {});
  const prompt = format(JD_RESUME_OPTIMIZE_PROMPT, {
    jd_text: jdText || '',
    resume_json: resumeStr,
  });
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    { task: AI_TASK.JD_RESUME_OPTIMIZE, model: options.model },
    onChunk,
  );
  const parsed = extractJson(content);
  if (!parsed || Object.keys(parsed).length === 0) {
    return { data: { resume: {}, optimization_notes: [] }, meta: { model, usage, cost } };
  }
  // 兼容 AI 直接返回 resume 根对象或嵌套在 resume 字段内
  const rawResume = parsed.resume && typeof parsed.resume === 'object' ? parsed.resume : parsed;
  const resume = normalizePdfResume(rawResume);
  return {
    data: {
      resume: hasResumeContent(resume) ? resume : {},
      optimization_notes: parsed.optimization_notes || [],
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
  // 工作经历（正式全职）优化
  optimizeWorkExperienceStream,
  matchJd,
  scoreResume,
  optimizeFromPdfText,
  optimizeFromPdfTextStream,
  optimizePdfByJdStream,
  optimizeResumeByJdStream,
  extractJdFromImage,
};
