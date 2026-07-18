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
    || source['意向岗位']
    || source['求职岗位']
    || source['面试岗位']
    || source['应聘岗位']
    || ''
  );
  if (options.strict) return explicitTarget;
  return explicitTarget || source.position || source.job_title || source.jobTitle || '';
}

module.exports = { hasResumeContent, extractTargetPosition };
