/**
 * AI服务模块 - 核心业务逻辑
 * 封装所有与 DeepSeek API 交互的功能：
 * 1. AI简历生成 - 根据用户输入生成专业校招简历
 * 2. AI项目优化 - 使用STAR法则优化项目经历描述
 * 3. JD岗位匹配 - 分析简历与岗位JD的匹配度
 * 4. AI简历评分 - 多维度评估简历质量
 */

const axios = require('axios');
const { settings } = require('../config');
const { calcAiCost, normalizeUsage } = require('../utils/ai_cost');

const AI_TASK = {
  RESUME_GENERATE: 'resume_generate',
  PROJECT_OPTIMIZE: 'project_optimize',
  JD_MATCH: 'jd_match',
  SCORE: 'score',
  PDF_OPTIMIZE: 'pdf_optimize',
};

function resolveModel(task, model) {
  // 模型优先级：接口传入 > 业务专属环境变量 > 全局默认模型
  if (model && String(model).trim()) {
    return String(model).trim();
  }
  const modelMap = {
    [AI_TASK.RESUME_GENERATE]: settings.DEEPSEEK_MODEL_RESUME_GENERATE,
    [AI_TASK.PROJECT_OPTIMIZE]: settings.DEEPSEEK_MODEL_PROJECT_OPTIMIZE,
    [AI_TASK.JD_MATCH]: settings.DEEPSEEK_MODEL_JD_MATCH,
    [AI_TASK.SCORE]: settings.DEEPSEEK_MODEL_SCORE,
    [AI_TASK.PDF_OPTIMIZE]: settings.DEEPSEEK_MODEL_PDF_OPTIMIZE,
  };
  return (modelMap[task] || settings.DEEPSEEK_MODEL || 'deepseek-v4-flash').trim();
}

// ========== AI Prompt 模板 ==========

const RESUME_GENERATE_PROMPT = `你是一名资深互联网HR和技术面试官。
请根据用户提供的信息生成一份专业校招简历。
要求：
1. 输出标准JSON格式，包含以下字段：name, school, major, education, phone, email, summary, skills(数组), projects(数组，每个包含name/role/description/tech_stack/start_date/end_date), internships(数组，每个包含company/position/description/start_date/end_date), awards(数组), certificates(数组)
2. 项目经历使用STAR法则描述，突出技术亮点和量化成果
3. 个人评价(summary)要专业、简洁，3-5句话
4. 技能标签要具体，如Vue3而非Vue
5. 内容专业，适合互联网校招场景
6. 只输出JSON，不要输出其他内容

用户信息如下：
{user_input}`;

// 智能识别：解析非结构化自由文本并生成简历
const LAZY_GENERATE_PROMPT = `你是一名资深互联网HR和技术面试官。
用户以自由文本形式提供了简历相关信息（可能是键值对、分段描述、列表或口语化内容）。
请按以下步骤处理：
1. 智能提取姓名、学校、专业、学历、手机、邮箱、技能、项目经历、实习经历、获奖、证书等信息
2. 若文本中缺少某些字段，可合理推断或留空字符串/空数组，不要编造虚假信息
3. 若用户额外提供了 target_position（求职方向），优先使用该方向优化简历内容
4. 项目经历使用STAR法则描述，突出技术亮点和量化成果
5. 个人评价(summary)要专业、简洁，3-5句话
6. 技能标签要具体，如Vue3而非Vue
7. 输出标准JSON格式，包含以下字段：name, school, major, education, phone, email, summary, skills(数组), projects(数组，每个包含name/role/description/tech_stack/start_date/end_date), internships(数组，每个包含company/position/description/start_date/end_date), awards(数组), certificates(数组)
8. 只输出JSON，不要输出其他内容

用户输入如下：
{user_input}

补充求职方向（如有）：{target_position}`;

const OPTIMIZE_PROJECT_PROMPT = `你是一名资深互联网技术面试官和简历优化专家。
请优化以下项目经历描述，要求：
1. 使用STAR法则（情境-任务-行动-结果）
2. 突出技术亮点和架构能力
3. 量化成果（如提升效率XX%、支持XX并发等）
4. 补充关键技术栈细节
5. 语言专业简洁，适合校招简历
6. 输出JSON格式：{"optimized": "优化后的描述", "highlights": ["亮点1", "亮点2"]}

目标岗位：{target_position}
原始描述：{project_description}`;

const JD_MATCH_PROMPT = `你是一名资深互联网HR，擅长简历与岗位匹配分析。
请根据简历内容和岗位JD进行匹配分析，要求：
1. 提取岗位JD的关键技术关键词
2. 分析简历与岗位的匹配度（0-100分）
3. 找出简历中缺失的技能
4. 给出优化建议
5. 输出JSON格式：{"match_score": 85, "keywords": ["Vue3", "TypeScript"], "missing_skills": ["React"], "suggestions": ["增加React项目经验", "补充性能优化案例"]}

简历内容：
{resume_content}

岗位JD：
{jd_text}`;

const SCORE_PROMPT = `你是一名资深互联网HR和简历评审专家。
请对以下简历进行评分，评分维度：
1. 内容完整度(0-20分)：基本信息、项目、实习、技能是否完整
2. 技能匹配度(0-20分)：技能是否与目标岗位匹配
3. 项目质量(0-30分)：项目描述是否使用STAR法则，是否有量化成果
4. 简历结构(0-15分)：各模块排列是否合理
5. 排版规范(0-15分)：格式是否规范、专业
输出JSON格式：{"content_completeness": 15, "skill_match": 16, "project_quality": 22, "resume_structure": 12, "format_quality": 13, "total": 78}

简历内容：
{resume_content}`;

// PDF简历深度优化完整版Prompt模板
const PDF_OPTIMIZE_PROMPT = `
你是拥有8年招聘与简历优化经验的资深HR+职业简历优化专家，熟悉不同行业、岗位方向和用人筛选标准，擅长根据用户指定的求职/优化方向，使用STAR法则、数据量化、业务价值表达提升简历通过率。
本次用户指定的优化方向是：{target_position}
请严格围绕该方向处理用户简历原文，不得默认成互联网、技术、校招或任何固定行业；如果原文方向与用户指定方向不一致，请在不编造经历的前提下，突出可迁移能力、相关项目/经历和匹配关键词。
严格按照以下全套要求处理用户简历原文，不得遗漏任何规则：

## 一、基础信息结构化提取（必须完整识别，缺失字段填空字符串/空数组）
完整提取字段，严格区分数据类型：
1. name：姓名 字符串
2. phone：联系电话 字符串，无则""
3. email：邮箱 字符串，无则""
4. education：教育经历数组，每项结构：
   {"school":"学校名称","major":"专业","degree":"学历（本科/硕士）","start_date":"入学年月","end_date":"毕业年月","gpa":"绩点，无则填写无"}
5. summary：个人简介，3-5句话，总字数80-150字；贴合目标岗位，突出匹配度、核心技术栈、工作年限、核心业务能力、个人优势
6. skills：技能标签数组，拆分颗粒度细化，禁止笼统词汇；按与目标方向匹配度从高到低排序；技术岗可细分编程语言/框架/工具，非技术岗可细分专业能力/业务工具/行业知识/证书资质
   示例规范：技术方向可写["Vue3 + Vite","TypeScript","Node.js Express"]；运营方向可写["用户增长","数据分析","活动策划"]；财务方向可写["财务分析","Excel建模","会计准则"]；不允许写"能力强"这类模糊词
7. projects：项目经历数组，每一项严格包含子字段：
   {
     "name":"项目全称",
     "role":"你在项目内的角色（独立开发/前端负责人/后端开发/全栈工程师）",
     "tech_stack":["用到的全部技术栈，和skills格式统一"],
     "start_date":"项目开始年月",
     "end_date":"项目结束年月",
     "description":"使用STAR法则重构，分场景、任务、行动、结果四段；全部内容量化成果，拒绝空泛描述；突出业务价值、性能优化、效率提升、降本、流量、用户量、接口并发、代码重构等数据"
   }
8. internships：实习经历数组，每项结构：
   {"company":"公司名称","position":"实习岗位","start_date":"入职年月","end_date":"离职年月","description":"STAR量化重写，侧重学习落地、功能开发、协作成果"}
9. awards：获奖数组，每项字符串：["2024 校级一等奖学金","全国大学生计算机竞赛二等奖"]，无则[]
10. certificates：证书数组，每项字符串：["计算机二级","软考中级前端开发","阿里云云计算认证"]，无则[]

## 二、简历优化硬性规则（必须全部执行）
1. 描述量化强制要求：所有经历必须添加数字成果，例如：
   错误示范：优化页面性能；
   标准示范：通过懒加载+组件拆分优化首屏加载速度60%，接口响应耗时从800ms降至180ms，支撑日均5000次访问；
2. STAR法则标准执行：每段经历固定逻辑
   S场景：项目/业务背景、业务痛点；
   T任务：你的负责模块、核心目标；
   A行动：你落地的技术方案、编码实现、架构调整；
   R结果：数据化收益、业务指标提升、解决的核心问题；
3. 技能精细化：禁止宽泛词汇，细分版本、配套工具；区分精通/熟练技术排序；
4. 个人简介精准匹配目标方向：所有内容倾斜用户填写的目标方向，弱化无关经历，突出匹配关键词、可迁移能力和岗位价值；
5. 修正口语化、流水账表述，全部改为职场专业书面语，删除无效废话（打杂、参与、协助等弱化词汇，替换为主导、独立设计、重构、落地）；
6. 补齐简历缺失亮点：如果原文缺少量化数据，基于对应行业合理补充真实可信的业务量化指标；不编造虚假工作年限、公司、项目名称；
7. 统一时间格式：全部为「2022.03」年月格式，至今在职填写「至今」；
8. 剔除冗余无效信息：校园无关活动、过时老旧技术、无价值打杂描述；

## 三、优化总结要求
optimization_notes：数组，固定输出4-5条精准优化要点，每条简短清晰，示例：
["补充项目量化业务数据，提升简历竞争力","采用STAR法则重构全部项目描述","细化技术栈颗粒度，区分Vue3/Vue2等版本","精简个人简介，贴合目标岗位需求","删除无价值打杂类描述，突出个人主导工作"]

## 四、输出强制约束（违规直接作废）
1. 仅输出纯JSON字符串，禁止输出任何解释、标题、markdown、换行注释、思考文字；
2. JSON不能丢失任何规定字段，空值统一为""、空数组[]；
3. 字段名称严格和要求一致，大小写完全匹配，不能新增/删减key；
4. 禁止JSON转义错误、语法错误，保证可直接JSON.parse解析；

## 输入信息
目标方向：{target_position}
简历原文：
{pdf_text}
`;

/**
 * 简单字符串模板替换工具，等价于 Python 的 str.format
 * @param {string} tpl 包含 {key} 占位符的模板
 * @param {object} vars 变量对象
 */
function format(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? String(vars[key]) : ''));
}

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
 * 从AI返回的文本中提取JSON对象
 * AI返回的内容可能包含 markdown 代码块标记等额外文本
 * 此函数定位第一个 { 和最后一个 } 之间的内容进行解析
 * 解析失败返回空对象
 */
function extractJson(text) {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}') + 1;
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end));
    }
  } catch (e) {
    /* ignore */
  }
  return {};
}

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
 * 根据输入模式选择 Prompt 模板
 * @param {object|string} bodyOrString 用户输入
 * @param {object} options { inputMode: 'lazy' | 'form' }
 */
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

/**
 * AI生成简历
 * 将用户填写的信息格式化为Prompt，调用DeepSeek生成专业校招简历
 */
async function generateResume(userInput, options = {}) {
  const prompt = resolveGeneratePrompt(userInput, options);
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.RESUME_GENERATE, model: options.model });
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * 流式 AI 生成简历 - 增量推送原始文本，最终解析 JSON
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
 * AI优化项目经历描述
 * 使用STAR法则优化用户原始项目描述，突出技术亮点和量化成果
 */
async function optimizeProject(projectDescription, targetPosition = '', options = {}) {
  const prompt = format(OPTIMIZE_PROJECT_PROMPT, {
    project_description: projectDescription,
    target_position: targetPosition || '通用技术岗位',
  });
  const { content, usage, model, cost } = await callDeepseek(prompt, { task: AI_TASK.PROJECT_OPTIMIZE, model: options.model });
  return { data: extractJson(content), meta: { model, usage, cost } };
}

/**
 * JD岗位匹配分析
 * 对比简历内容与岗位JD，分析匹配度、缺失技能和优化建议
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
 * AI简历评分
 * 从5个维度对简历进行评分：内容完整度、技能匹配度、项目质量、简历结构、排版规范
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
 * 基于上传的 PDF 简历原文，整体提取并优化简历
 * @param {string} pdfText pdf-parse 提取出的纯文本
 * @param {string} targetPosition 用户期望优化的目标岗位（可选）
 * @returns {Promise<{resume: object, optimization_notes: string[]}>}
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
  matchJd,
  scoreResume,
  optimizeFromPdfText,
  optimizeFromPdfTextStream,
};
