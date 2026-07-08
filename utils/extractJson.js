/**
 * 从 AI 返回的文本中提取 JSON 对象
 * AI 返回的内容可能包含 markdown 代码块标记等额外文本
 * 此函数定位第一个 { 和最后一个 } 之间的内容进行解析
 * 解析失败返回空对象
 *
 * @param {string} text AI 返回的原始文本
 * @returns {object}
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

module.exports = { extractJson };
