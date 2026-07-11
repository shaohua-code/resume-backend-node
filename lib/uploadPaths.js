/**
 * 上传目录路径统一管理
 * 物理路径由 UPLOAD_DIR 环境变量控制，与 Git 仓库解耦
 */

const fs = require('fs')
const path = require('path')
const { settings } = require('../config')

/** 上传根目录（默认项目内 data/uploads） */
const UPLOAD_ROOT = settings.UPLOAD_DIR

/** PDF 简历目录：每用户一份，覆盖写入，不对外暴露 URL */
const PDFS_DIR = path.join(UPLOAD_ROOT, 'pdfs')

/** 头像、反馈图片等资源目录，通过 /uploads/assets/ 静态访问 */
const ASSETS_DIR = path.join(UPLOAD_ROOT, 'assets')

/** 对外 URL 前缀 */
const ASSETS_URL_PREFIX = '/uploads/assets'

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
 * 获取用户 PDF 物理路径
 * @param {string} userId
 * @returns {string}
 */
function getUserPdfPath(userId) {
  return path.join(PDFS_DIR, `${userId}.pdf`)
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
  ensureUploadDirs,
  getUserPdfPath,
  getUserAssetsDir,
  buildAssetUrl,
}
