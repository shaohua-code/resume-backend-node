/**
 * AES-256-GCM 对称加密工具
 * 用于敏感数据的可逆加密存储（如用户密码记录）
 *
 * 使用场景：
 * - 管理员需要查看用户原始密码（客服、身份验证等）
 * - 不用于登录验证（登录仍使用 bcrypt 不可逆哈希）
 *
 * 安全特性：
 * - AES-256-GCM：认证加密模式，防篡改
 * - 每次加密生成随机 IV（初始化向量），相同明文产生不同密文
 * - 密钥从环境变量读取，不硬编码
 */

const crypto = require('crypto')

// 算法配置
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16        // IV 向量长度（128位）
const TAG_LENGTH = 16       // GCM 认证标签长度（128位）
const KEY_LENGTH = 32       // AES-256 密钥长度（256位）

/**
 * 获取或生成加密密钥
 * @param {string} rawKey 原始密钥字符串（从环境变量 ENCRYPTION_KEY 读取）
 * @returns {Buffer} 32 字节的加密密钥
 */
function getEncryptionKey(rawKey) {
  // 使用 SHA-256 哈希将任意长度的原始密钥转换为固定的 32 字节密钥
  return crypto.createHash('sha256').update(rawKey).digest()
}

/**
 * 加密明文
 * @param {string} plaintext 要加密的文本
 * @param {string} key 加密密钥（环境变量 ENCRYPTION_KEY）
 * @returns {string} Base64 编码的密文（格式：IV:Tag:Ciphertext）
 */
function encrypt(plaintext, key) {
  if (!plaintext || typeof plaintext !== 'string') {
    return ''
  }

  const encryptionKey = getEncryptionKey(key)
  // 每次加密生成随机 IV，确保相同明文产生不同密文
  const iv = crypto.randomBytes(IV_LENGTH)

  // 创建加密器
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv)

  // 加密数据
  let encrypted = cipher.update(plaintext, 'utf8', 'binary')
  encrypted += cipher.final('binary')

  // 获取 GCM 认证标签（用于验证数据完整性）
  const tag = cipher.getAuthTag()

  // 组合输出格式：Base64(IV + Tag + Ciphertext)
  // 格式便于存储和传输
  const combined = Buffer.concat([iv, tag, Buffer.from(encrypted, 'binary')])
  return combined.toString('base64')
}

/**
 * 解密密文
 * @param {string} ciphertext Base64 编码的密文（由 encrypt 函数生成）
 * @param {string} key 加密密钥（必须与加密时使用的密钥一致）
 * @returns {string} 解密后的明文
 * @throws {Error} 如果密文无效、密钥错误或数据被篡改
 */
function decrypt(ciphertext, key) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return ''
  }

  try {
    const encryptionKey = getEncryptionKey(key)

    // 从 Base64 解码
    const combined = Buffer.from(ciphertext, 'base64')

    // 提取 IV、Tag、Ciphertext
    const iv = combined.subarray(0, IV_LENGTH)
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH)

    // 创建解密器并设置认证标签
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv)
    decipher.setAuthTag(tag)

    // 解密数据
    let decrypted = decipher.update(encrypted, 'binary', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  } catch (error) {
    // 解密失败可能原因：
    // 1. 密文格式错误
    // 2. 加密密钥不匹配
    // 3. 数据被篡改（GCM 标签验证失败）
    console.error('[encryption] 解密失败:', error.message)
    throw new Error('解密失败：密文无效或密钥不匹配')
  }
}

/**
 * 生成随机加密密钥（用于首次配置）
 * @returns {string} 64 位十六进制字符串（256 位）
 */
function generateRandomKey() {
  const key = crypto.randomBytes(KEY_LENGTH).toString('hex')
  console.log(`[encryption] 生成随机密钥（256位）: ${key}`)
  return key
}

module.exports = {
  encrypt,
  decrypt,
  generateRandomKey,
}
