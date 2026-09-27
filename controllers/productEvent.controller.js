const { getUserByToken } = require('../services/auth/auth.service')
const productEvents = require('../services/productEvents/productEvents.service')
const { handleError } = require('../utils/response')

async function collect(req, res) {
  try {
    if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > 16 * 1024) {
      return res.status(413).json({ success: false, detail: '行为记录内容过大' })
    }
    const authorization = req.headers.authorization || ''
    let userId = null
    if (authorization.startsWith('Bearer ')) {
      const user = await getUserByToken(authorization.slice(7))
      userId = user?.id || null
    }
    const data = await productEvents.recordEvents(userId, req.body?.events)
    return res.status(202).json({ success: true, data })
  } catch (error) {
    return handleError(res, error)
  }
}

module.exports = { collect }
