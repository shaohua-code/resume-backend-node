/**
 * IAM 中央授权守卫回归用例；注入身份与权限服务，验证安全分支且不连接数据库或外部 IAM。
 */
/**
 * IAM 中央授权守卫回归用例；注入身份与权限服务，验证安全分支且不连接数据库或外部 IAM。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { createIamAuthorizationGuard, getResourceId } = require('../middlewares/iamAuthorizationGuard')

const permissionCodes = {
  read: { code: 'resume.read', resourceScoped: true },
  write: { code: 'resume.write', resourceScoped: true },
  ai: { code: 'ai.generate', resourceScoped: false },
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

test('已绑定账号按服务端会话和请求资源执行中心权限检查', async () => {
  const calls = []
  const guard = createIamAuthorizationGuard({
    getIamIdentityLink: async (userId) => userId === 'local-user-1',
    requireIamPermission: async (...args) => calls.push(args),
    permissionCodes,
  })
  const req = { user: { id: 'local-user-1' }, params: { id: 'resume-1' }, query: {}, body: {} }
  const res = createResponse()
  let nextCalls = 0

  await guard('read')(req, res, () => { nextCalls += 1 })

  assert.deepEqual(calls, [['local-user-1', 'resume.read', 'resume-1']])
  assert.equal(nextCalls, 1)
  assert.equal(res.body, null)
})

test('未绑定账号继续使用既有本地 RBAC，不调用 IAM 服务', async () => {
  let permissionChecks = 0
  const guard = createIamAuthorizationGuard({
    getIamIdentityLink: async () => false,
    requireIamPermission: async () => { permissionChecks += 1 },
    permissionCodes,
  })
  const res = createResponse()
  let nextCalls = 0

  await guard('write')({ user: { id: 'local-user-2' }, params: {}, query: {}, body: {} }, res, () => { nextCalls += 1 })

  assert.equal(permissionChecks, 0)
  assert.equal(nextCalls, 1)
  assert.equal(res.statusCode, 200)
})

test('AI 应用权限不把本地简历 ID 作为 IAM 资源 ID', async () => {
  const calls = []
  const guard = createIamAuthorizationGuard({
    getIamIdentityLink: async () => true,
    requireIamPermission: async (...args) => calls.push(args),
    permissionCodes,
  })

  await guard('ai')({ user: { id: 'local-user-3' }, params: { id: 'local-resume-9' }, query: {}, body: {} }, createResponse(), () => {})

  assert.deepEqual(calls, [['local-user-3', 'ai.generate', undefined]])
})

test('中心拒绝不会进入本地放行路径', async () => {
  const guard = createIamAuthorizationGuard({
    getIamIdentityLink: async () => true,
    requireIamPermission: async () => { throw Object.assign(new Error('当前账号没有执行该操作的中心权限'), { statusCode: 403 }) },
    permissionCodes,
  })
  const res = createResponse()
  let nextCalls = 0

  await guard('read')({ user: { id: 'local-user-4' }, params: {}, query: {}, body: {} }, res, () => { nextCalls += 1 })

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { detail: '当前账号没有执行该操作的中心权限' })
  assert.equal(nextCalls, 0)
})

test('未知上游异常统一 fail closed 且不泄漏内部错误', async () => {
  const guard = createIamAuthorizationGuard({
    getIamIdentityLink: async () => { throw new Error('postgres://private-host/secret') },
    requireIamPermission: async () => {},
    permissionCodes,
  })
  const res = createResponse()
  let nextCalls = 0

  await guard('read')({ user: { id: 'local-user-5' }, params: {}, query: {}, body: {} }, res, () => { nextCalls += 1 })

  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { detail: 'IAM 中央授权暂不可用' })
  assert.equal(nextCalls, 0)
})

test('资源标识优先读取路由参数并限制最大长度', () => {
  assert.equal(getResourceId({ params: { id: 'route-id' }, query: { resume_id: 'query-id' }, body: {} }), 'route-id')
  assert.equal(getResourceId({ params: {}, query: { resume_id: 'query-id' }, body: {} }), 'query-id')
  assert.equal(getResourceId({ params: {}, query: {}, body: { id: 'x'.repeat(300) } }).length, 256)
  assert.equal(getResourceId({ params: {}, query: {}, body: {} }), undefined)
})
