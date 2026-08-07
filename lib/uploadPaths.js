/**
 * 上传目录路径统一管理
 * 物理路径由 UPLOAD_DIR 环境变量控制，与 Git 仓库解耦
 */

const fs = require('fs')
const path = require('path')
const { settings } = require('../config')

/** 上传根目录（默认项目内 data/uploads） */
const UPLOAD_ROOT = settings.UPLOAD_DIR

/** 简历源文件目录：每用户一份（pdf/docx），覆盖写入，不对外暴露 URL */
const PDFS_DIR = path.join(UPLOAD_ROOT, 'pdfs')

/** 头像、反馈图片等资源目录，通过 /uploads/assets/ 静态访问 */
const ASSETS_DIR = path.join(UPLOAD_ROOT, 'assets')

/** 对外 URL 前缀 */
const ASSETS_URL_PREFIX = '/uploads/assets'

/** 简历识别/优化允许的源文件扩展名（旧版 .doc 不在此列） */
const RESUME_FILE_EXTENSIONS = ['.pdf', '.docx']

/**
 * 确保上传子目录存在
 */
function ensureUploadDirs() {
  for (const dir of [UPLOAD_ROOT, PDFS_DIR, ASSETS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}

/**
 * 按扩展名拼出用户简历源文件路径
 * @param {string} userId
 * @param {string} ext 含点号，如 .pdf / .docx
 */
function getUserResumePathByExt(userId, ext) {
  const normalized = String(ext || '').toLowerCase()
  return path.join(PDFS_DIR, `${userId}${normalized}`)
}

/**
 * 查找用户当前已保存的唯一简历源文件（优先存在的 .pdf / .docx）
 * @param {string} userId
 * @returns {{ filePath: string, ext: string } | null}
 */
function findUserResumeFile(userId) {
  for (const ext of RESUME_FILE_EXTENSIONS) {
    const filePath = getUserResumePathByExt(userId, ext)
    if (fs.existsSync(filePath)) {
      return { filePath, ext }
    }
  }
  return null
}

/**
 * 获取用户简历源文件物理路径（兼容旧调用名）
 * 优先返回已存在文件；若尚无文件则默认回落为 .pdf 路径（供写入前拼路径场景）
 * @param {string} userId
 * @returns {string}
 */
function getUserPdfPath(userId) {
  const found = findUserResumeFile(userId)
  if (found) return found.filePath
  return getUserResumePathByExt(userId, '.pdf')
}

/**
 * 删除该用户其它扩展名的旧简历源文件，保证每人只保留一份
 * @param {string} userId
 * @param {string} keepExt 本次要保留的扩展名（含点号）
 */
function clearUserResumeOtherExts(userId, keepExt) {
  const keep = String(keepExt || '').toLowerCase()
  for (const ext of RESUME_FILE_EXTENSIONS) {
    if (ext === keep) continue
    const filePath = getUserResumePathByExt(userId, ext)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }
}

/**
 * 获取用户资源上传目录
 * @param {string} userId
 * @returns {string}
 */
function getUserAssetsDir(userId) {
  return path.join(ASSETS_DIR, userId)
}

/**
 * 根据文件名生成对外访问 URL
 * @param {string} userId
 * @param {string} filename
 * @returns {string}
 */
function buildAssetUrl(userId, filename) {
  return `${ASSETS_URL_PREFIX}/${userId}/${filename}`
}

module.exports = {
  UPLOAD_ROOT,
  PDFS_DIR,
  ASSETS_DIR,
  ASSETS_URL_PREFIX,
  RESUME_FILE_EXTENSIONS,
  ensureUploadDirs,
  getUserPdfPath,
  getUserResumePathByExt,
  findUserResumeFile,
  clearUserResumeOtherExts,
  getUserAssetsDir,
  buildAssetUrl,
}
