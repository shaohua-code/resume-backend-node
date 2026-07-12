/**
 * PostgreSQL 查询兼容层
 * 将 .from().select().eq() 链式调用翻译为 PostgreSQL 查询
 */

const db = require('./db')

const TABLE_WHITELIST = new Set([
  'users', 'otp_codes', 'refresh_tokens', 'user_profile', 'resume', 'export_record',
  'membership_plan', 'order_record', 'ai_call_record', 'system_config', 'announcement',
  'ai_model', 'admin_action_log', 'user_feedback', 'user_wallet', 'balance_ledger',
  'admin_user_relation', 'invite_link', 'visit_log',
])

function assertTable(table) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`非法表名: ${table}`)
  }
}

function mapPgError(err) {
  if (!err) return null
  return { message: err.message || String(err), code: err.code || '' }
}

function wrapResult(rows, count, error, singleMode, maybeSingleMode) {
  if (error) {
    return { data: null, error: mapPgError(error), count: 0 }
  }
  const list = rows || []
  if (singleMode) {
    if (!list.length) {
      return { data: null, error: { message: '未找到记录', code: 'PGRST116' }, count: 0 }
    }
    return { data: list[0], error: null, count: 1 }
  }
  if (maybeSingleMode) {
    return { data: list[0] || null, error: null, count: list.length }
  }
  return { data: list, error: null, count: count ?? list.length }
}

class PgQueryBuilder {
  constructor(table) {
    assertTable(table)
    this.table = table
    this.alias = 't'
    this.action = 'select'
    this.columns = '*'
    this.filters = []
    this.orderBy = null
    this.rangeFrom = null
    this.rangeTo = null
    this.limitVal = null
    this.countMode = false
    this.headOnly = false
    this.singleMode = false
    this.maybeSingleMode = false
    this.insertData = null
    this.updateData = null
    this.upsertData = null
    this.upsertConflict = 'config_key'
    this.returnColumns = null
    this.joinSpec = null
    this._executed = false
    this._result = null
  }

  select(columns = '*', options = {}) {
    // insert/update/upsert/delete 后的 select 表示 RETURNING 列，不是改成查询
    if (['insert', 'update', 'upsert', 'delete'].includes(this.action)) {
      this.returnColumns = columns
      if (options.count === 'exact') this.countMode = true
      if (options.head) this.headOnly = true
      return this
    }
    this.action = 'select'
    this.parseColumns(columns)
    if (options.count === 'exact') this.countMode = true
    if (options.head) this.headOnly = true
    return this
  }

  parseColumns(columns) {
    const raw = String(columns || '*').trim()
    if (raw.includes('membership_plan(')) {
      this.columns = '*'
      this.joinSpec = {
        table: 'membership_plan',
        fk: 'plan_id',
        pk: 'id',
        nestedField: 'name',
        nestedKey: 'membership_plan',
      }
      return
    }
    this.columns = raw
  }

  insert(payload) {
    this.action = 'insert'
    this.insertData = payload
    return this
  }

  update(payload) {
    this.action = 'update'
    this.updateData = payload
    return this
  }

  upsert(payload, options = {}) {
    this.action = 'upsert'
    this.upsertData = payload
    if (options.onConflict) this.upsertConflict = options.onConflict
    return this
  }

  delete() {
    this.action = 'delete'
    return this
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value })
    return this
  }

  in(column, values) {
    this.filters.push({ type: 'in', column, values: values || [] })
    return this
  }

  or(expression) {
    this.filters.push({ type: 'or', expression: String(expression || '') })
    return this
  }

  gte(column, value) {
    this.filters.push({ type: 'gte', column, value })
    return this
  }

  gt(column, value) {
    this.filters.push({ type: 'gt', column, value })
    return this
  }

  lt(column, value) {
    this.filters.push({ type: 'lt', column, value })
    return this
  }

  order(column, options = {}) {
    const dir = options.ascending === false ? 'DESC' : 'ASC'
    this.orderBy = { column, dir }
    return this
  }

  range(from, to) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }

  limit(n) {
    this.limitVal = n
    return this
  }

  single() {
    this.singleMode = true
    return this.execute()
  }

  maybeSingle() {
    this.maybeSingleMode = true
    return this.execute()
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }

  buildWhere(params) {
    const clauses = []
    for (const f of this.filters) {
      if (f.type === 'eq') {
        params.push(f.value)
        clauses.push(`${this.alias}.${f.column} = $${params.length}`)
      } else if (f.type === 'in') {
        if (!f.values.length) {
          clauses.push('1 = 0')
        } else {
          const ph = f.values.map((v) => {
            params.push(v)
            return `$${params.length}`
          })
          clauses.push(`${this.alias}.${f.column} IN (${ph.join(', ')})`)
        }
      } else if (f.type === 'gte') {
        params.push(f.value)
        clauses.push(`${this.alias}.${f.column} >= $${params.length}`)
      } else if (f.type === 'gt') {
        params.push(f.value)
        clauses.push(`${this.alias}.${f.column} > $${params.length}`)
      } else if (f.type === 'lt') {
        params.push(f.value)
        clauses.push(`${this.alias}.${f.column} < $${params.length}`)
      } else if (f.type === 'or') {
        const parts = f.expression.split(',').map((p) => p.trim()).filter(Boolean)
        const orClauses = []
        for (const part of parts) {
          const m = part.match(/^(\w+)\.ilike\.%(.+)%$/)
          if (m) {
            params.push(`%${m[2]}%`)
            orClauses.push(`${this.alias}.${m[1]} ILIKE $${params.length}`)
          }
        }
        if (orClauses.length) clauses.push(`(${orClauses.join(' OR ')})`)
      }
    }
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  }

  async execute() {
    if (this._executed) return this._result
    this._executed = true
    try {
      if (this.action === 'insert') return await this.runInsert()
      if (this.action === 'update') return await this.runUpdate()
      if (this.action === 'upsert') return await this.runUpsert()
      if (this.action === 'delete') return await this.runDelete()
      return await this.runSelect()
    } catch (err) {
      this._result = wrapResult(null, 0, err, this.singleMode, this.maybeSingleMode)
      return this._result
    }
  }

  formatReturning() {
    if (!this.returnColumns) return '*'
    const raw = String(this.returnColumns).trim()
    if (!raw || raw === '*') return '*'
    return raw.split(',').map((c) => c.trim()).filter(Boolean).join(', ')
  }

  async runInsert() {
    const keys = Object.keys(this.insertData)
    const values = Object.values(this.insertData)
    const ph = keys.map((_, i) => `$${i + 1}`).join(', ')
    const returning = this.formatReturning()
    const sql = `INSERT INTO public.${this.table} (${keys.join(', ')}) VALUES (${ph}) RETURNING ${returning}`
    const { rows } = await db.query(sql, values)
    return wrapResult(rows, rows.length, null, this.singleMode, this.maybeSingleMode)
  }

  async runUpdate() {
    const params = []
    const sets = Object.entries(this.updateData).map(([k, v]) => {
      params.push(v)
      return `${k} = $${params.length}`
    })
    const where = this.buildWhere(params)
    const returning = this.formatReturning()
    const sql = `UPDATE public.${this.table} AS ${this.alias} SET ${sets.join(', ')}${where} RETURNING ${returning}`
    const { rows } = await db.query(sql, params)
    return wrapResult(rows, rows.length, null, this.singleMode, this.maybeSingleMode)
  }

  async runUpsert() {
    const keys = Object.keys(this.upsertData)
    const values = Object.values(this.upsertData)
    const ph = keys.map((_, i) => `$${i + 1}`).join(', ')
    const updates = keys
      .filter((k) => k !== this.upsertConflict)
      .map((k) => `${k} = EXCLUDED.${k}`)
      .join(', ')
    const sql = `INSERT INTO public.${this.table} (${keys.join(', ')}) VALUES (${ph})
      ON CONFLICT (${this.upsertConflict}) DO UPDATE SET ${updates} RETURNING ${this.formatReturning()}`
    const { rows } = await db.query(sql, values)
    return wrapResult(rows, rows.length, null, this.singleMode, this.maybeSingleMode)
  }

  async runDelete() {
    const params = []
    const where = this.buildWhere(params)
    const needReturning = this.returnColumns || this.singleMode || this.maybeSingleMode
    const ret = needReturning ? ` RETURNING ${this.formatReturning()}` : ''
    const sql = `DELETE FROM public.${this.table} AS ${this.alias}${where}${ret}`
    const { rows, rowCount } = await db.query(sql, params)
    return wrapResult(rows, rowCount, null, this.singleMode, this.maybeSingleMode)
  }

  async runSelect() {
    const params = []
    const where = this.buildWhere(params)
    let fromClause = `public.${this.table} AS ${this.alias}`
    let selectCols = `${this.alias}.*`

    if (this.joinSpec) {
      const j = this.joinSpec
      assertTable(j.table)
      fromClause += ` LEFT JOIN public.${j.table} AS j ON ${this.alias}.${j.fk} = j.${j.pk}`
      selectCols = `${this.alias}.*, CASE WHEN j.${j.pk} IS NOT NULL THEN json_build_object('${j.nestedField}', j.${j.nestedField}) ELSE NULL END AS ${j.nestedKey}`
    } else if (this.columns !== '*') {
      selectCols = this.columns.split(',').map((c) => `${this.alias}.${c.trim()}`).join(', ')
    }

    if (this.headOnly && this.countMode) {
      const { rows } = await db.query(`SELECT COUNT(*)::int AS cnt FROM ${fromClause}${where}`, params)
      return { data: null, error: null, count: rows[0]?.cnt || 0 }
    }

    let count = null
    if (this.countMode) {
      const { rows: cr } = await db.query(`SELECT COUNT(*)::int AS cnt FROM ${fromClause}${where}`, params)
      count = cr[0]?.cnt || 0
    }

    let sql = `SELECT ${selectCols} FROM ${fromClause}${where}`
    if (this.orderBy) {
      sql += ` ORDER BY ${this.alias}.${this.orderBy.column} ${this.orderBy.dir}`
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      params.push(this.rangeTo - this.rangeFrom + 1, this.rangeFrom)
      sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`
    } else if (this.limitVal !== null) {
      params.push(this.limitVal)
      sql += ` LIMIT $${params.length}`
    }

    const { rows } = await db.query(sql, params)
    return wrapResult(rows, count ?? rows.length, null, this.singleMode, this.maybeSingleMode)
  }
}

const pgAdmin = {
  from(table) {
    return new PgQueryBuilder(table)
  },
}

module.exports = { pgAdmin, PgQueryBuilder }
