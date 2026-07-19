/**
 * 判断标准简历中是否至少存在一项真实内容。
 * 递归检查数组/对象，避免空占位记录被误判为有效简历。
 */
const RESUME_CONTENT_FIELDS = [
  'name',
  'target_position',
  'phone',
  'email',
  'summary',
  'avatar',
  'work_years',
  'marital_status',
  'height',
  'weight',
  'ethnicity',
  'native_place',
  'political_status',
  'expected_salary',
  'school',
  'major',
  'main_course',
  'education',
  'custom_fields',
  'educations',
  'skills',
  'projects',
  'internships',
  'work_experiences',
  'awards',
  'certificates',
];

function hasMeaningfulValue(value) {
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasMeaningfulValue);
  }
  return false;
}

function hasResumeContent(resume = {}) {
  return RESUME_CONTENT_FIELDS.some((field) => hasMeaningfulValue(resume[field]));
}

/**
 * 提取目标岗位。纯识别模式只接受明确的求职意向字段，不能把当前职位误判为目标岗位；
 * 历史生成/优化接口继续兼容 position、job_title 等宽松别名。
 */
function extractTargetPosition(source = {}, options = {}) {
  const explicitTarget = (
    source.target_position
    || source.targetPosition
    // 示例与常见简历原文多用「求职意向」，必须纳入严格模式别名
    || source['求职意向']
    || source['意向岗位']
    || source['目标岗位']
    || source['期望岗位']
    || source['求职岗位']
    || source['面试岗位']
    || source['应聘岗位']
    || source['意向职位']
    || source.job_intention
    || source.jobIntention
    || ''
  );
  if (options.strict) return String(explicitTarget || '').trim();
  return String(
    explicitTarget || source.position || source.job_title || source.jobTitle || '',
  ).trim();
}

/**
 * 从简历原文中回退提取求职意向。
 * 模型漏填 target_position、或只按中文标签返回时使用，避免「求职意向」整行丢失。
 */
function extractTargetPositionFromText(text = '') {
  const source = String(text || '');
  if (!source.trim()) return '';
  const match = source.match(
    /(?:求职意向|意向岗位|目标岗位|期望岗位|求职岗位|应聘岗位|意向职位)\s*[:：]\s*([^\n，,；;]+)/,
  );
  return match ? String(match[1] || '').trim() : '';
}

module.exports = { hasResumeContent, extractTargetPosition, extractTargetPositionFromText };
