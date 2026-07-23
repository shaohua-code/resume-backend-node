/**
 * AI 服务模块
 * 封装 OpenAI Chat Completions 兼容模型调用：
 * 1. PDF/文字简历事实识别
 * 2. AI 简历生成
 * 3. AI 项目/个人评价/技能/实习优化
 * 4. JD 岗位匹配
 * 5. AI 简历评分
 * 6. PDF 简历整体优化
 */

const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const { calcAiCost, normalizeUsage } = require('../../utils/ai_cost');
const { extractJson, extractJsonSafe } = require('../../utils/extractJson');
const {
  AI_TASK,
  resolveModelConfig,
  resolveDeepseekFallbackConfig,
} = require('./ai.model');
const { withDeepseekFallback } = require('./ai.fallback');
const {
  hasResumeContent,
  extractTargetPosition,
  extractTargetPositionFromText,
} = require('./resume-content');
const { enrichProjectsFromSource } = require('./resume-projects');
const { JD_IMAGE_EXTRACT_PROMPT } = require('./ai.prompts');
const { resolveFormattedPrompt } = require('./ai.promptResolve');
const {
  normalizeScoreResult,
  normalizeJdMatchResult,
  createScoreVisibleChunkHandler,
} = require('./ai.resultNormalize');

/** 组装任务 Prompt：支持用户/管理员指令覆盖，输出格式始终由代码锁定 */
async function buildTaskPrompt(taskType, vars, options = {}, promptKey) {
  return resolveFormattedPrompt(taskType, vars, {
    userId: options.userId,
    promptKey,
  });
}

function modelCallOptions(task, options = {}) {
  return { task, model: options.model, userId: options.userId };
}

// 组装调用元信息，供 recordAiCall 写入审计表
async function buildMeta(model, usage) {
  const normalizedUsage = normalizeUsage(usage);
  const cost = await calcAiCost(model, normalizedUsage);
  return { model, usage: normalizedUsage, cost };
}

/**
 * 统一校验后台模型记录对应的运行参数，避免请求发出后才暴露配置错误。
 */
function assertRuntimeConfig(runtime) {
  if (!runtime.apiKey) {
    const err = new Error(`${runtime.name} API Key 未配置，请在服务端环境变量 ${runtime.apiKeyEnv || '（未指定）'} 中设置密钥`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  if (!runtime.apiUrl) {
    const err = new Error(`${runtime.name} API 地址未配置`);
    err.code = 'CONFIG_MISSING';
    throw err;
  }
}

/**
 * 按供应商写入深度思考开关。
 * DeepSeek V4 默认开启思考，必须用 thinking.type；enable_thinking 对其无效。
 * DashScope 等兼容接口继续使用 enable_thinking。
 */
function applyRuntimeOptions(payload, runtime) {
  if (typeof runtime.thinkingEnabled !== 'boolean') return payload;
  const provider = String(runtime.provider || '').trim().toLowerCase();
  if (provider === 'deepseek') {
    payload.thinking = { type: runtime.thinkingEnabled ? 'enabled' : 'disabled' };
  } else {
    payload.enable_thinking = runtime.thinkingEnabled;
  }
  return payload;
}

/** 从调用 options 提取温度、max_tokens、JSON 模式等可选参数 */
function pickCallOptions(options = {}) {
  const callOptions = {};
  if (typeof options.temperature === 'number') callOptions.temperature = options.temperature;
  if (typeof options.max_tokens === 'number') callOptions.max_tokens = options.max_tokens;
  if (options.responseFormat) callOptions.responseFormat = options.responseFormat;
  return callOptions;
}

/**
 * OpenAI Chat Completions 兼容接口通用方法（历史函数名保留为内部兼容）。
 * @returns {Promise<{ content: string, usage: object, model: string, cost: number }>}
 */
async function callChatCompletion(prompt, runtime, callOptions = {}) {
  assertRuntimeConfig(runtime);
  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
    'Content-Type': 'application/json',
  };
  const model = runtime.modelKey;
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: typeof callOptions.temperature === 'number' ? callOptions.temperature : 0.7,
    max_tokens: typeof callOptions.max_tokens === 'number' ? callOptions.max_tokens : 4096,
  };
  if (callOptions.responseFormat) {
    payload.response_format = callOptions.responseFormat;
  }
  applyRuntimeOptions(payload, runtime);
  const response = await axios.post(runtime.apiUrl, payload, {
    headers,
    timeout: 60000,
  });
  const usage = normalizeUsage(response.data.usage || {});
  const cost = await calcAiCost(model, usage);
  // 只取最终回答；思考过程在 reasoning_content，不能参与 JSON 解析
  const message = response.data.choices?.[0]?.message || {};
  return {
    content: message.content || '',
    usage,
    model,
    cost,
  };
}

async function callDeepseek(prompt, options = {}) {
  const callOptions = pickCallOptions(options);
  return withDeepseekFallback(
    options.task,
    async () => {
      // 传入 userId 以应用用户级任务模型覆盖（开关关闭时自动忽略）
      const runtime = await resolveModelConfig(options.task, options.model, options.userId);
      return callChatCompletion(prompt, runtime, callOptions);
    },
    () => callChatCompletion(prompt, resolveDeepseekFallbackConfig(options.task), callOptions),
  );
}

/**
 * 安全消费上游 SSE：用 StringDecoder 拼接跨 TCP 包的多字节 UTF-8，
 * 避免 chunk.toString() 把中文截成「」。
 */
function consumeChatCompletionSse(responseStream, onChunk) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let full = '';
    let remainder = '';
    let usage = {};
    // 记录结束原因：length 表示输出被 max_tokens 截断
    let finishReason = '';

    const handleSseLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices?.[0] || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        // 忽略 reasoning_content，避免思考过程污染结构化 JSON
        const content = choice.delta?.content || '';
        if (content) {
          full += content;
          if (typeof onChunk === 'function') onChunk(content, full);
        }
      } catch (e) {
        /* ignore partial json */
      }
    };

    responseStream.on('data', (chunk) => {
      remainder += decoder.write(chunk);
      const lines = remainder.split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) handleSseLine(line);
    });

    responseStream.on('end', () => {
      // 冲刷解码器中未完成的多字节字符，并处理最后半行
      remainder += decoder.end();
      if (remainder.trim()) handleSseLine(remainder);
      resolve({ content: full, usage, finishReason });
    });
    responseStream.on('error', reject);
  });
}

/**
 * 流式调用 OpenAI 兼容接口，通过 onChunk 回调推送增量文本。
 * @returns {Promise<{ content: string, usage: object, model: string, cost: number }>}
 */
async function callChatCompletionStream(prompt, runtime, onChunk, callOptions = {}) {
  assertRuntimeConfig(runtime);
  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
    'Content-Type': 'application/json',
  };
  const model = runtime.modelKey;
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: typeof callOptions.temperature === 'number' ? callOptions.temperature : 0.7,
    max_tokens: typeof callOptions.max_tokens === 'number' ? callOptions.max_tokens : 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (callOptions.responseFormat) {
    payload.response_format = callOptions.responseFormat;
  }
  applyRuntimeOptions(payload, runtime);
  const response = await axios.post(runtime.apiUrl, payload, {
    headers,
    timeout: 120000,
    responseType: 'stream',
  });

  const { content, usage, finishReason } = await consumeChatCompletionSse(response.data, onChunk);
  const meta = await buildMeta(model, usage);
  return { content, finishReason, ...meta };
}

async function callDeepseekStream(prompt, options = {}, onChunk) {
  let primaryEmittedContent = false;
  const handlePrimaryChunk = (chunk, full) => {
    primaryEmittedContent = true;
    if (typeof onChunk === 'function') onChunk(chunk, full);
  };
  const callOptions = pickCallOptions(options);

  return withDeepseekFallback(
    options.task,
    async () => {
      const runtime = await resolveModelConfig(options.task, options.model, options.userId);
      return callChatCompletionStream(prompt, runtime, handlePrimaryChunk, callOptions);
    },
    () => callChatCompletionStream(
      prompt,
      resolveDeepseekFallbackConfig(options.task),
      onChunk,
      callOptions,
    ),
    {
      // 已推送的半截内容无法从 SSE 客户端撤回；此时禁止拼接第二份流，
      // 继续沿用首次错误。只有首个内容片段前失败才安全兜底。
      canFallback: () => !primaryEmittedContent,
    },
  );
}

/**
 * 多模态视觉调用：从图片提取文本（非流式）
 * 视觉任务调用。实际模型与供应商由后台任务映射决定。
 * @param {Buffer} imageBuffer 图片二进制
 * @param {string} mimeType 如 image/jpeg
 */
async function callDeepseekVision(imageBuffer, mimeType, textPrompt, options = {}) {
  const runtime = await resolveModelConfig(options.task, options.model, options.userId);
  assertRuntimeConfig(runtime);
  const model = runtime.modelKey;
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
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
  applyRuntimeOptions(payload, runtime);
  const response = await axios.post(runtime.apiUrl, payload, {
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
  // degree 只接受字符串，避免 education[] 误入扁平字段后污染
  const rawDegree = item.degree || item.education || '';
  let degree = typeof rawDegree === 'string' ? rawDegree : '';
  let major = item.major || '';
  // 仅单段专业（无换行/分号/斜杠拼接）时，从「通信技术（大专）」拆出学历
  if (major && !degree && !/[\n；;]|\s+\/\s+/.test(major)) {
    const parsed = splitMajorAndDegree(major);
    if (parsed.degree) {
      major = parsed.major;
      degree = parsed.degree;
    }
  }
  return {
    school: item.school || item.school_name || item.schoolName || '',
    major,
    main_course: item.main_course || item.mainCourse || '',
    degree,
    start_date: item.start_date || item.startDate || '',
    end_date: item.end_date || item.endDate || '',
  };
}

function normalizeCustomField(item = {}) {
  return {
    label: (item.label || '').trim(),
    value: (item.value || '').trim(),
  };
}

/**
 * 把技能/证书等列表项安全转成可读字符串。
 * 禁止对对象直接 String()，否则会变成 [object Object]。
 */
function stringifyListItem(item) {
  if (item === undefined || item === null) return '';
  if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
    return String(item).trim();
  }
  if (typeof item === 'object') {
    const text = (
      item.name
      || item.title
      || item.label
      || item.skill
      || item.certificate
      || item.award
      || item.value
      || item.text
      || item.content
      || ''
    );
    if (text) return String(text).trim();
    const values = Object.values(item).filter((v) => typeof v === 'string' || typeof v === 'number');
    if (values.length === 1) return String(values[0]).trim();
  }
  return '';
}

/** 将字符串或数组统一为去空字符串数组。 */
function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(stringifyListItem).filter(Boolean);
  }
  if (!value) return [];
  if (typeof value === 'object') {
    const text = stringifyListItem(value);
    return text ? [text] : [];
  }
  return String(value).split(/[\n,，、]/).map((item) => item.trim()).filter(Boolean);
}

/** 拆分被模型错误合并进同一字段的多段教育信息。 */
function splitEducationField(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const parts = text
    .split(/\n+|；|;|\s+\/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

/** 从「通信技术（大专）」这类文案中拆出专业与学历。 */
function splitMajorAndDegree(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { major: '', degree: '' };
  const match = raw.match(/^(.+?)[（(]\s*(大专|本科|硕士|博士|研究生|专科|高中|中专)\s*[）)]$/);
  if (match) {
    return { major: match[1].trim(), degree: match[2].trim() };
  }
  return { major: raw, degree: '' };
}

/**
 * 从「学校A 专业（大专） 学校B 专业（本科）」这类粘连文本中尽量拆成多段。
 */
function splitStickyEducationText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const schoolHits = raw.match(/[\u4e00-\u9fa5A-Za-z0-9（）()]{2,}(?:大学|学院|学校|职业技术学院|职业技术大学)/g) || [];
  if (schoolHits.length < 2) return [];

  const parts = [];
  let cursor = 0;
  schoolHits.forEach((school, index) => {
    const start = raw.indexOf(school, cursor);
    if (start < 0) return;
    const nextSchool = schoolHits[index + 1];
    const end = nextSchool ? raw.indexOf(nextSchool, start + school.length) : raw.length;
    const chunk = raw.slice(start, end >= 0 ? end : raw.length).trim();
    const rest = chunk.slice(school.length).trim().replace(/^[,，、|｜\-\s]+/, '');
    const parsed = splitMajorAndDegree(rest);
    parts.push({
      school,
      major: parsed.major,
      degree: parsed.degree,
    });
    cursor = start + school.length;
  });
  return parts;
}

/** 把合并的一条教育记录尽量拆成多条。 */
function expandMergedEducationItems(list = []) {
  const result = [];
  list.forEach((item) => {
    const schools = splitEducationField(item.school);
    const majors = splitEducationField(item.major);
    const degrees = splitEducationField(item.degree);
    const startDates = splitEducationField(item.start_date);
    const endDates = splitEducationField(item.end_date);
    const courses = splitEducationField(item.main_course);

    if (schools.length > 1) {
      schools.forEach((school, index) => {
        const majorSource = majors[index] || '';
        const parsed = splitMajorAndDegree(majorSource);
        result.push({
          school,
          major: parsed.major || majorSource,
          degree: degrees[index] || parsed.degree || '',
          start_date: startDates[index] || (index === 0 ? item.start_date : '') || '',
          end_date: endDates[index] || (index === 0 ? item.end_date : '') || '',
          main_course: courses[index] || '',
        });
      });
      return;
    }

    // 注意：[] 在 JS 中为真值，不能用 || 串联
    const stickyFromSchool = splitStickyEducationText(item.school);
    const sticky = stickyFromSchool.length > 1
      ? stickyFromSchool
      : splitStickyEducationText([item.school, item.major].filter(Boolean).join(' '));
    if (sticky.length > 1) {
      sticky.forEach((part, index) => {
        result.push({
          school: part.school,
          major: part.major || majors[index] || '',
          degree: part.degree || degrees[index] || '',
          start_date: startDates[index] || (index === 0 ? item.start_date : '') || '',
          end_date: endDates[index] || (index === 0 ? item.end_date : '') || '',
          main_course: courses[index] || '',
        });
      });
      return;
    }

    result.push(item);
  });
  return result;
}

/**
 * 归一化教育背景数组，兼容 educations[] / education[] 与扁平 school/major/education
 */
function normalizeEducations(source = {}) {
  let list = [];
  if (Array.isArray(source.educations) && source.educations.length) {
    list = source.educations;
  } else if (Array.isArray(source.education_list) && source.education_list.length) {
    list = source.education_list;
  } else if (Array.isArray(source.education) && source.education.length) {
    list = source.education;
  }

  if (list.length) {
    const normalized = list
      .map(normalizeEducationItem)
      .filter((item) => item.school || item.major || item.main_course || item.degree || item.start_date || item.end_date);
    return expandMergedEducationItems(normalized);
  }

  const flatEducation = typeof source.education === 'string' ? source.education : '';
  if (source.school || source.major || source.main_course || source.mainCourse || flatEducation || source.degree) {
    return expandMergedEducationItems([normalizeEducationItem({
      school: source.school,
      major: source.major,
      main_course: source.main_course || source.mainCourse,
      degree: flatEducation || source.degree,
      start_date: source.start_date,
      end_date: source.end_date,
    })]);
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

function normalizeProject(project = {}) {
  // 兼容 title / project_name / content 等模型别名
  return {
    name: project.name || project.project_name || project.projectName || project.title || '',
    role: project.role || project.position || '',
    description: project.description || project.content || project.desc || '',
    tech_stack: joinTechStack(project.tech_stack || project.skills || project.techStack),
    start_date: project.start_date || project.startDate || '',
    end_date: project.end_date || project.endDate || '',
  };
}

/** 从多种字段名中取出项目数组。 */
function pickProjectList(source = {}) {
  const candidates = [
    source.projects,
    source.project_experiences,
    source.projectExperiences,
    source.project_list,
    source.projectList,
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) return list;
  }
  // 整段项目被写成字符串时降级为单条，避免静默丢弃
  if (typeof source.projects === 'string' && source.projects.trim()) {
    return [{ description: source.projects.trim() }];
  }
  return [];
}

/** 从多种字段名取出公司名称（兼容模型别名与中文键） */
function pickCompanyName(item = {}) {
  const value = item.company
    || item.company_name
    || item.companyName
    || item.employer
    || item.organization
    || item.org
    || item.unit
    || item.firm
    || item['公司']
    || item['公司名称']
    || item['单位']
    || item['工作单位']
    || item['就职单位']
    || item['实习单位']
    || item['企业']
    || '';
  return String(value || '').trim();
}

/** 从多种字段名取出职位 */
function pickPositionName(item = {}) {
  const value = item.position
    || item.job_title
    || item.jobTitle
    || item.title
    || item.role
    || item['职位']
    || item['岗位']
    || item['职务']
    || item['实习岗位']
    || '';
  return String(value || '').trim();
}

function normalizeInternship(internship = {}) {
  return {
    company: pickCompanyName(internship),
    position: pickPositionName(internship),
    description: internship.description || internship.content || internship.desc || internship['描述'] || internship['工作内容'] || '',
    start_date: internship.start_date || internship.startDate || internship['开始时间'] || '',
    end_date: internship.end_date || internship.endDate || internship['结束时间'] || '',
  };
}

function normalizeWorkExperience(work = {}) {
  return {
    company: pickCompanyName(work),
    position: pickPositionName(work),
    department: work.department || work.dept || work['部门'] || '',
    description: work.description || work.content || work.desc || work['描述'] || work['工作内容'] || '',
    start_date: work.start_date || work.startDate || work['开始时间'] || '',
    end_date: work.end_date || work.endDate || work['结束时间'] || '',
  };
}

/** 从多种字段名取出实习数组 */
function pickInternshipList(source = {}) {
  const candidates = [
    source.internships,
    source.internship_experiences,
    source.internshipExperiences,
    source.internship_list,
    source.internshipList,
    source['实习经历'],
    source['实习经验'],
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) return list;
  }
  if (typeof source.internships === 'string' && source.internships.trim()) {
    return [{ description: source.internships.trim() }];
  }
  return [];
}

/** 从多种字段名取出正式工作数组 */
function pickWorkExperienceList(source = {}) {
  const candidates = [
    source.work_experiences,
    source.workExperiences,
    source.work_experience,
    source.workExperience,
    source.jobs,
    source.employments,
    source['工作经历'],
    source['工作经验'],
    source['任职经历'],
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) return list;
  }
  if (typeof source.work_experiences === 'string' && source.work_experiences.trim()) {
    return [{ description: source.work_experiences.trim() }];
  }
  return [];
}

function normalizePdfResume(data, options = {}) {
  const source = data.resume && typeof data.resume === 'object' ? data.resume : data;
  const educations = normalizeEducations(source);
  const firstEdu = educations[0] || normalizeEducation(source.education);
  const customFields = normalizeCustomFields(source);

  return {
    name: source.name || '',
    // 纯识别只接受明确求职意向；历史优化接口继续兼容通用岗位别名。
    target_position: extractTargetPosition(source, { strict: options.strictTargetPosition }),
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
    // 扁平 education 仅同步学历字符串，避免数组残留
    education: (typeof source.education === 'string' ? source.education : '') || firstEdu.degree || source.degree || '',
    skills: normalizeStringList(source.skills),
    projects: pickProjectList(source)
      .map(normalizeProject)
      .filter((item) => item.name || item.role || item.description || item.tech_stack || item.start_date || item.end_date),
    internships: pickInternshipList(source)
      .map(normalizeInternship)
      .filter((item) => item.company || item.position || item.description || item.start_date || item.end_date),
    // 工作经历（正式全职工作，区别于实习）
    work_experiences: pickWorkExperienceList(source)
      .map(normalizeWorkExperience)
      .filter((item) => item.company || item.position || item.department || item.description || item.start_date || item.end_date),
    awards: normalizeStringList(source.awards),
    certificates: normalizeStringList(source.certificates),
  };
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

async function resolveGeneratePrompt(bodyOrString, options = {}) {
  const isLazy = options.inputMode === 'lazy';
  if (isLazy) {
    const body = typeof bodyOrString === 'object' ? bodyOrString : {};
    const rawText = body.raw_text || (typeof bodyOrString === 'string' ? bodyOrString : '');
    const targetPosition = body.target_position || '';
    return buildTaskPrompt(AI_TASK.RESUME_GENERATE, {
      user_input: rawText,
      target_position: targetPosition || '未指定',
    }, options, 'lazy_generate');
  }
  const userInput = typeof bodyOrString === 'string'
    ? bodyOrString
    : JSON.stringify(bodyOrString);
  return buildTaskPrompt(AI_TASK.RESUME_GENERATE, { user_input: userInput }, options);
}

/**
 * 规范化亮点文案列表，过滤空项与「无需修改」类套话
 */
function normalizeNoteList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((note) => !/无需修改|已较完善|微调即可|暂无调整/.test(note));
}

/**
 * 从模型 JSON 中尽量提取 optimization_notes（兼容别名与嵌套）
 */
function pickOptimizationNotes(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const candidates = [
    parsed.optimization_notes,
    parsed.optimizationNotes,
    parsed.notes,
    parsed.highlights,
    parsed['优化亮点'],
    parsed['本次优化亮点'],
    parsed.resume?.optimization_notes,
    parsed.resume?.optimizationNotes,
    parsed.resume?.notes,
  ];
  for (const candidate of candidates) {
    const notes = normalizeNoteList(candidate);
    if (notes.length) return notes.slice(0, 5);
  }
  return [];
}

/**
 * 模型未返回亮点时，按简历内容生成后端兜底说明（保证前端「本次优化亮点」可展示）
 */
function buildFallbackOptimizationNotes(resume, mode = 'generate') {
  const data = resume || {};
  const notes = [];
  const verb = mode === 'optimize' ? '优化' : '生成';
  if (String(data.summary || '').trim()) {
    notes.push(`已${verb}个人评价，突出与目标岗位的匹配表达`);
  }
  if (Array.isArray(data.skills) && data.skills.length) {
    notes.push(`已整理 ${data.skills.length} 项核心技能关键词`);
  }
  const experienceCount =
    (Array.isArray(data.projects) ? data.projects.length : 0) +
    (Array.isArray(data.internships) ? data.internships.length : 0) +
    (Array.isArray(data.work_experiences) ? data.work_experiences.length : 0);
  if (experienceCount > 0) {
    notes.push('已补强项目/实习/工作经历的职责与交付描述');
  }
  if (Array.isArray(data.educations) && data.educations.length) {
    notes.push('已规范教育背景字段结构，便于招聘方快速扫描');
  }
  if (String(data.target_position || '').trim()) {
    notes.push(`已围绕「${data.target_position}」对齐简历表达侧重点`);
  }
  while (notes.length < 3) {
    notes.push(
      mode === 'optimize'
        ? '已按招聘筛选口径提升简历可读性与岗位相关性'
        : '已按目标岗位补全可投递的完整简历结构',
    );
  }
  return notes.slice(0, 5);
}

/**
 * 统一解包 { resume, optimization_notes }；扁平根对象也可恢复简历，并兜底亮点
 */
function unpackWrappedResumeResult(parsed, mode = 'generate') {
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    return { resume: {}, optimization_notes: [] };
  }
  const resume = normalizePdfResume(parsed);
  let notes = pickOptimizationNotes(parsed);
  if (!notes.length && hasResumeContent(resume)) {
    notes = buildFallbackOptimizationNotes(resume, mode);
  }
  return {
    resume: hasResumeContent(resume) ? resume : {},
    optimization_notes: notes,
  };
}

// ========== 对外服务方法 ==========

/**
 * AI 生成简历（非流式）
 * 统一返回 { resume, optimization_notes }，亮点由模型总结；缺失时后端兜底
 */
async function generateResume(userInput, options = {}) {
  const prompt = await resolveGeneratePrompt(userInput, options);
  const { content, usage, model, cost } = await callDeepseek(prompt, {
    ...modelCallOptions(AI_TASK.RESUME_GENERATE, options),
    // 强制 JSON 对象，提升 resume + optimization_notes 包装成功率
    responseFormat: { type: 'json_object' },
  });
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'generate'),
    meta: { model, usage, cost },
  };
}

/**
 * 流式 AI 生成简历
 * 统一返回 { resume, optimization_notes }，亮点由模型总结；缺失时后端兜底
 */
async function generateResumeStream(userInput, options = {}, onChunk) {
  const prompt = await resolveGeneratePrompt(userInput, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    {
      ...modelCallOptions(AI_TASK.RESUME_GENERATE, options),
      responseFormat: { type: 'json_object' },
    },
    onChunk,
  );
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'generate'),
    meta: { model, usage, cost },
  };
}

/**
 * 从 PDF 解析文本或用户粘贴文本中纯识别结构化简历。
 * 这里刻意使用独立 Prompt，不复用任何生成/优化提示词，避免识别阶段改写原始内容。
 */
async function extractResumeFromTextStream(resumeText, options = {}, onChunk) {
  const sourceText = String(resumeText || '').trim();
  // 有效字符过少时不进模型，避免无意义计费并给出更准确提示。
  const meaningfulChars = sourceText.replace(/\s+/g, '');
  if (meaningfulChars.length < 30) {
    const err = new Error('简历文本过短或有效内容不足，请检查后重试');
    err.code = 'RESUME_TEXT_TOO_SHORT';
    err.statusCode = 400;
    throw err;
  }

  const prompt = await buildTaskPrompt(AI_TASK.RESUME_EXTRACT, {
    resume_source: sourceText,
  }, options);
  // 识别任务要稳定 JSON：低温 + 更大输出窗口（完整提取易超长）+ JSON 模式
  const { content, usage, model, cost, finishReason } = await callDeepseekStream(
    prompt,
    {
      ...modelCallOptions(AI_TASK.RESUME_EXTRACT, options),
      temperature: 0.1,
      max_tokens: 12288,
      responseFormat: { type: 'json_object' },
    },
    onChunk,
  );
  // 区分解析失败与合法空结果，避免 JSON 瑕疵被误报成“无简历信息”。
  const { ok, data: parsed } = extractJsonSafe(content);
  if (!ok) {
    const truncated = finishReason === 'length';
    const err = new Error(
      truncated
        ? '识别结果过长被截断，请缩短原文后重试或更换模型'
        : 'AI 返回内容无法解析为结构化简历，请重试',
    );
    err.code = truncated ? 'RESUME_JSON_TRUNCATED' : 'RESUME_JSON_PARSE_FAILED';
    // 便于排查：记录截断预览，避免把整份简历打进日志
    err.detail = String(content || '').slice(0, 240);
    throw err;
  }
  if (!parsed || Object.keys(parsed).length === 0) {
    return { data: { resume: {} }, meta: { model, usage, cost } };
  }

  // 禁止把模型偶尔返回的当前职位 position/job_title 推断成用户求职意向。
  const resume = normalizePdfResume(parsed, { strictTargetPosition: true });
  // 模型漏提「求职意向」时，从原文标签行回填，避免示例与真实简历都丢岗位
  if (!resume.target_position) {
    resume.target_position = extractTargetPositionFromText(sourceText);
  }
  // 用原文「项目简介/项目职责」块回填：补回漏掉的首条项目与完整职责列表
  resume.projects = enrichProjectsFromSource(sourceText, resume.projects);
  return {
    data: { resume: hasResumeContent(resume) ? resume : {} },
    meta: { model, usage, cost },
  };
}

/**
 * AI 优化项目经历描述（非流式）
 */
async function optimizeProject(projectDescription, targetPosition = '', options = {}) {
  const prompt = await buildTaskPrompt(AI_TASK.PROJECT_OPTIMIZE, {
    project_description: projectDescription,
    project_record: JSON.stringify({ description: projectDescription || '' }),
    target_position: targetPosition || '通用职业方向',
    resume_context: '',
  }, options);
  const { content, usage, model, cost } = await callDeepseek(prompt, modelCallOptions(AI_TASK.PROJECT_OPTIMIZE, options));
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化项目经历描述
 */
async function optimizeProjectStream(project, resume, targetPosition = '', options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.PROJECT_OPTIMIZE, {
    project_description: project.description || '',
    project_record: JSON.stringify(project || {}),
    target_position: targetPosition || '通用职业方向',
    resume_context: buildResumeContext(resume),
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.PROJECT_OPTIMIZE, options),
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化个人评价
 */
async function optimizeSummaryStream(resume, targetPosition = '', options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.SUMMARY_OPTIMIZE, {
    target_position: targetPosition || '通用职业方向',
    resume_context: buildResumeContext(resume),
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.SUMMARY_OPTIMIZE, options),
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化技能特长
 */
async function optimizeSkillsStream(resume, targetPosition = '', options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.SKILLS_OPTIMIZE, {
    target_position: targetPosition || '通用职业方向',
    skills: Array.isArray(resume.skills) ? resume.skills.join('、') : '',
    resume_context: buildResumeContext(resume),
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.SKILLS_OPTIMIZE, options),
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式优化实习经历描述
 */
async function optimizeInternshipStream(internship, resume, targetPosition = '', options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.INTERNSHIP_OPTIMIZE, {
    internship_description: internship.description || '',
    internship_record: JSON.stringify(internship || {}),
    target_position: targetPosition || '通用职业方向',
    resume_context: buildResumeContext(resume),
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.INTERNSHIP_OPTIMIZE, options),
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
  const prompt = await buildTaskPrompt(AI_TASK.WORK_EXPERIENCE_OPTIMIZE, {
    work_experience_description: workExp.description || '',
    work_experience_record: JSON.stringify(workExp || {}),
    target_position: targetPosition || '通用职业方向',
    resume_context: buildResumeContext(resume),
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.WORK_EXPERIENCE_OPTIMIZE, options),
    onChunk,
  );
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * JD 岗位匹配分析
 */
async function matchJd(resumeContent, jdText, options = {}) {
  const prompt = await buildTaskPrompt(AI_TASK.JD_MATCH, { resume_content: resumeContent, jd_text: jdText }, options);
  // 同步分析启用 JSON 模式，降低模型夹带说明文字导致结构化字段丢失的概率。
  const { content, usage, model, cost } = await callDeepseek(prompt, {
    ...modelCallOptions(AI_TASK.JD_MATCH, options),
    responseFormat: { type: 'json_object' },
  });
  const parsed = extractJson(content);
  return {
    data: normalizeJdMatchResult(parsed, jdText),
    meta: { model, usage, cost },
  };
}

/**
 * AI 简历评分
 */
async function scoreResume(resumeContent, options = {}) {
  const prompt = await buildTaskPrompt(AI_TASK.SCORE, { resume_content: resumeContent }, options);
  // 非流式评分同样锁定 JSON 响应，确保五个维度可被稳定读取。
  const { content, usage, model, cost } = await callDeepseek(prompt, {
    ...modelCallOptions(AI_TASK.SCORE, options),
    responseFormat: { type: 'json_object' },
  });
  const parsed = extractJson(content);
  return {
    data: normalizeScoreResult(parsed),
    meta: { model, usage, cost },
  };
}

/**
 * 多模态视觉流式调用：从图片提取文本并通过 onChunk 推送增量文本。
 * @param {Buffer} imageBuffer 图片二进制
 * @param {string} mimeType 如 image/jpeg
 */
async function callDeepseekVisionStream(imageBuffer, mimeType, textPrompt, options = {}, onChunk) {
  const runtime = await resolveModelConfig(options.task, options.model, options.userId);
  assertRuntimeConfig(runtime);
  const model = runtime.modelKey;
  const base64 = imageBuffer.toString('base64');
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;
  const headers = {
    Authorization: `Bearer ${runtime.apiKey}`,
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
    stream: true,
    stream_options: { include_usage: true },
  };
  applyRuntimeOptions(payload, runtime);
  const response = await axios.post(runtime.apiUrl, payload, {
    headers,
    timeout: 120000,
    responseType: 'stream',
  });

  // 与文本流共用安全解码，避免视觉流中文同样被截成乱码
  const { content, usage } = await consumeChatCompletionSse(response.data, onChunk);
  const meta = await buildMeta(model, usage);
  return { content, ...meta };
}

function parseScorePayload(content) {
  const jsonMatch = String(content || '').match(/<SCORE_JSON>([\s\S]*?)<\/SCORE_JSON>/i);
  const parsed = jsonMatch ? extractJson(jsonMatch[1]) : extractJson(content);
  return normalizeScoreResult(parsed);
}

async function scoreResumeStream(resumeContent, options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.SCORE, { resume_content: resumeContent }, options, 'score_stream');
  const visibleChunkHandler = createScoreVisibleChunkHandler(onChunk);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    modelCallOptions(AI_TASK.SCORE, options),
    visibleChunkHandler,
  );
  visibleChunkHandler.flush();
  return { data: parseScorePayload(content), meta: { model, usage, cost } };
}

/**
 * 基于 PDF 文本整体优化简历（非流式）
 */
async function optimizeFromPdfText(pdfText, targetPosition = '', options = {}) {
  const prompt = await buildTaskPrompt(AI_TASK.PDF_OPTIMIZE, {
    pdf_text: pdfText,
    target_position: targetPosition || '通用职业方向',
  }, options);
  const { content, usage, model, cost } = await callDeepseek(prompt, modelCallOptions(AI_TASK.PDF_OPTIMIZE, options));
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'optimize'),
    meta: { model, usage, cost },
  };
}

/**
 * 从 JD 图片中提取岗位描述文本（OCR/视觉模型）
 */
async function extractJdFromImage(imageBuffer, mimeType = 'image/jpeg', options = {}) {
  // 视觉 OCR：指令可被覆盖，默认仍用代码完整 Prompt
  const textPrompt = await buildTaskPrompt(AI_TASK.JD_IMAGE_EXTRACT, {}, options);
  const { content, usage, model, cost } = await callDeepseekVision(
    imageBuffer,
    mimeType,
    textPrompt || JD_IMAGE_EXTRACT_PROMPT,
    modelCallOptions(AI_TASK.JD_IMAGE_EXTRACT, options),
  );
  const jdText = String(content || '').trim();
  return {
    data: { jd_text: jdText },
    meta: { model, usage, cost },
  };
}

/**
 * 从 JD 图片中流式提取岗位描述文本（OCR/视觉模型）
 */
async function extractJdFromImageStream(imageBuffer, mimeType = 'image/jpeg', options = {}, onChunk) {
  const textPrompt = await buildTaskPrompt(AI_TASK.JD_IMAGE_EXTRACT, {}, options);
  const { content, usage, model, cost } = await callDeepseekVisionStream(
    imageBuffer,
    mimeType,
    textPrompt || JD_IMAGE_EXTRACT_PROMPT,
    modelCallOptions(AI_TASK.JD_IMAGE_EXTRACT, options),
    onChunk,
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
  const prompt = await buildTaskPrompt(AI_TASK.PDF_OPTIMIZE, {
    pdf_text: pdfText,
    target_position: targetPosition || '通用职业方向',
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    {
      ...modelCallOptions(AI_TASK.PDF_OPTIMIZE, options),
      responseFormat: { type: 'json_object' },
    },
    onChunk,
  );
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'optimize'),
    meta: { model, usage, cost },
  };
}

/**
 * 基于 PDF 原文 + 岗位 JD 流式优化简历（Upload 模式）
 */
async function optimizePdfByJdStream(pdfText, jdText = '', options = {}, onChunk) {
  const prompt = await buildTaskPrompt(AI_TASK.PDF_JD_OPTIMIZE, {
    pdf_text: pdfText || '',
    jd_text: jdText || '',
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    {
      ...modelCallOptions(AI_TASK.PDF_JD_OPTIMIZE, options),
      responseFormat: { type: 'json_object' },
    },
    onChunk,
  );
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'optimize'),
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
  const prompt = await buildTaskPrompt(AI_TASK.JD_RESUME_OPTIMIZE, {
    jd_text: jdText || '',
    resume_json: resumeStr,
  }, options);
  const { content, usage, model, cost } = await callDeepseekStream(
    prompt,
    {
      ...modelCallOptions(AI_TASK.JD_RESUME_OPTIMIZE, options),
      responseFormat: { type: 'json_object' },
    },
    onChunk,
  );
  const parsed = extractJson(content);
  return {
    data: unpackWrappedResumeResult(parsed, 'optimize'),
    meta: { model, usage, cost },
  };
}

module.exports = {
  generateResume,
  generateResumeStream,
  extractResumeFromTextStream,
  optimizeProject,
  optimizeProjectStream,
  optimizeSummaryStream,
  optimizeSkillsStream,
  optimizeInternshipStream,
  // 工作经历（正式全职）优化
  optimizeWorkExperienceStream,
  matchJd,
  scoreResume,
  scoreResumeStream,
  optimizeFromPdfText,
  optimizeFromPdfTextStream,
  optimizePdfByJdStream,
  optimizeResumeByJdStream,
  extractJdFromImage,
  extractJdFromImageStream,
};
