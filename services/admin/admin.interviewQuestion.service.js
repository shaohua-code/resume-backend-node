/** 管理题库查询复用现有管理员归属 ID，并对题目正文执行只读脱敏策略。 */
const interviewRepo = require('../../repositories/interviewQuestion.repository')
const {
  getOwnedUserIds, findUserIdsByKeyword, parseAdminDateRange, canAccessUser, logAdminAction,
} = require('./admin.common.service')

function intersectIds(primary, secondary) {
  if (primary === null) return secondary
  if (secondary === null) return primary
  const allowed = new Set(primary)
  return secondary.filter((id) => allowed.has(id))
}

async function listSets(req, pagination) {
  const ownedUserIds = await getOwnedUserIds(req.user)
  let userIds = ownedUserIds
  if (req.query.user_keyword) {
    const matching = await findUserIdsByKeyword(req.query.user_keyword, ownedUserIds)
    userIds = intersectIds(ownedUserIds, matching || [])
  }
  const { from: dateFrom, to: dateTo } = parseAdminDateRange(req.query)
  const result = await interviewRepo.listSets({
    ...pagination,
    userIds,
    userId: req.query.user_id || '',
    keyword: String(req.query.keyword || '').trim().replace(/[,%]/g, '').slice(0, 120),
    status: req.query.status || '',
    dateFrom: dateFrom || '',
    dateTo: dateTo || '',
  })
  return { ...result, items: result.items.map(({ email, ...item }) => ({ ...item, user: { nickname: item.nickname, email } })) }
}

async function getSet(req, setId) {
  const set = await interviewRepo.findSet(null, setId, { admin: true })
  if (!set) throw Object.assign(new Error('面试题套题不存在'), { statusCode: 404 })
  if (!await canAccessUser(req.user, set.user_id)) {
    throw Object.assign(new Error('无权查看该用户面试题'), { statusCode: 403 })
  }
  await logAdminAction(req, 'view_interview_question_set', 'interview_question_set', set.id)
  return set
}

module.exports = { listSets, getSet }
