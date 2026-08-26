/**
 * 把 geoip-lite 的英文/代码省市映射成中文展示值
 * 本地 IP 或解析失败统一写成「未知」，避免管理端空白
 */

const UNKNOWN = '未知'

const REGION_MAP = {
  BJ: '北京市',
  SH: '上海市',
  TJ: '天津市',
  CQ: '重庆市',
  HE: '河北省',
  HA: '河南省',
  SX: '山西省',
  NM: '内蒙古自治区',
  LN: '辽宁省',
  JL: '吉林省',
  HL: '黑龙江省',
  JS: '江苏省',
  ZJ: '浙江省',
  AH: '安徽省',
  FJ: '福建省',
  JX: '江西省',
  SD: '山东省',
  HB: '湖北省',
  HN: '湖南省',
  GD: '广东省',
  GX: '广西壮族自治区',
  HI: '海南省',
  SC: '四川省',
  GZ: '贵州省',
  YN: '云南省',
  XZ: '西藏自治区',
  SN: '陕西省',
  GS: '甘肃省',
  QH: '青海省',
  NX: '宁夏回族自治区',
  XJ: '新疆维吾尔自治区',
  TW: '台湾省',
  HK: '香港特别行政区',
  MO: '澳门特别行政区',
  11: '北京市',
  12: '天津市',
  13: '河北省',
  14: '山西省',
  15: '内蒙古自治区',
  21: '辽宁省',
  22: '吉林省',
  23: '黑龙江省',
  31: '上海市',
  32: '江苏省',
  33: '浙江省',
  34: '安徽省',
  35: '福建省',
  36: '江西省',
  37: '山东省',
  41: '河南省',
  42: '湖北省',
  43: '湖南省',
  44: '广东省',
  45: '广西壮族自治区',
  46: '海南省',
  50: '重庆市',
  51: '四川省',
  52: '贵州省',
  53: '云南省',
  54: '西藏自治区',
  61: '陕西省',
  62: '甘肃省',
  63: '青海省',
  64: '宁夏回族自治区',
  65: '新疆维吾尔自治区',
  Beijing: '北京市',
  Shanghai: '上海市',
  Tianjin: '天津市',
  Chongqing: '重庆市',
  Guangdong: '广东省',
  Zhejiang: '浙江省',
  Jiangsu: '江苏省',
  Sichuan: '四川省',
  Shandong: '山东省',
  Henan: '河南省',
  Hubei: '湖北省',
  Hunan: '湖南省',
  Anhui: '安徽省',
  Fujian: '福建省',
  Jiangxi: '江西省',
  Liaoning: '辽宁省',
  Jilin: '吉林省',
  Heilongjiang: '黑龙江省',
  Hebei: '河北省',
  Shanxi: '山西省',
  Shaanxi: '陕西省',
  Gansu: '甘肃省',
  Qinghai: '青海省',
  Yunnan: '云南省',
  Guizhou: '贵州省',
  Hainan: '海南省',
  Guangxi: '广西壮族自治区',
  'Inner Mongolia': '内蒙古自治区',
  Ningxia: '宁夏回族自治区',
  Xinjiang: '新疆维吾尔自治区',
  Tibet: '西藏自治区',
}

const CITY_MAP = {
  Beijing: '北京',
  Shanghai: '上海',
  Guangzhou: '广州',
  Shenzhen: '深圳',
  Hangzhou: '杭州',
  Chengdu: '成都',
  Wuhan: '武汉',
  Nanjing: '南京',
  Tianjin: '天津',
  Chongqing: '重庆',
  Suzhou: '苏州',
  Dongguan: '东莞',
  Foshan: '佛山',
  XiAn: '西安',
  "Xi'an": '西安',
  Xian: '西安',
  Qingdao: '青岛',
  Dalian: '大连',
  Xiamen: '厦门',
  Ningbo: '宁波',
  Changsha: '长沙',
  Zhengzhou: '郑州',
  Jinan: '济南',
  Hefei: '合肥',
  Fuzhou: '福州',
  Kunming: '昆明',
  Nanning: '南宁',
  Nanchang: '南昌',
  Shenyang: '沈阳',
  Harbin: '哈尔滨',
  Changchun: '长春',
  Shijiazhuang: '石家庄',
  Taiyuan: '太原',
  Hohhot: '呼和浩特',
  Wuxi: '无锡',
  Wenzhou: '温州',
  Zhuhai: '珠海',
  Zhongshan: '中山',
  Huizhou: '惠州',
}

const CJK_RE = /[\u4e00-\u9fff]/

function lookupMap(map, value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (CJK_RE.test(raw)) return raw
  return map[raw] || map[raw.toUpperCase()] || map[raw.replace(/\s+/g, '')] || ''
}

/**
 * 归一化省市展示值
 * @param {string} province geoip region 或已有中文
 * @param {string} city geoip city 或已有中文
 * @returns {{ province: string, city: string }}
 */
function formatGeo(province, city) {
  return {
    province: lookupMap(REGION_MAP, province) || UNKNOWN,
    city: lookupMap(CITY_MAP, city) || (CJK_RE.test(String(city || '')) ? String(city).trim() : UNKNOWN),
  }
}

module.exports = {
  UNKNOWN,
  formatGeo,
}
