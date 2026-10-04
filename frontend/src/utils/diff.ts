import type { SealedSnapshot } from '@/types'

/** 单条字段差异 */
export interface FieldDiff {
  /** 字段中文名 */
  label: string
  /** 基底值（已格式化） */
  before: string
  /** 草稿值（已格式化） */
  after: string
}

/** 一类记录的差异结果 */
export interface RecordDiff {
  /** 实体中文名 */
  entityLabel: string
  added: Array<{ id: string; label: string }>
  removed: Array<{ id: string; label: string }>
  changed: Array<{ id: string; label: string; fields: FieldDiff[] }>
}

export interface SnapshotDiff {
  /** 是否存在任何差异 */
  hasChanges: boolean
  trench: RecordDiff
  strata: RecordDiff
  artifacts: RecordDiff
  relations: RecordDiff
}

type Primitive = string | number | boolean | string[] | null | undefined

function emptyDiff(entityLabel: string): RecordDiff {
  return { entityLabel, added: [], removed: [], changed: [] }
}

function fmt(value: Primitive): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '—'
  return String(value)
}

function diffFields<T extends object>(
  before: T,
  after: T,
  fields: Array<{ key: keyof T & string; label: string }>
): FieldDiff[] {
  const result: FieldDiff[] = []
  for (const field of fields) {
    const beforeValue = (before as Record<string, unknown>)[field.key] as Primitive
    const afterValue = (after as Record<string, unknown>)[field.key] as Primitive
    const beforeText = fmt(beforeValue)
    const afterText = fmt(afterValue)
    if (beforeText !== afterText) {
      result.push({ label: field.label, before: beforeText, after: afterText })
    }
  }
  return result
}

function diffCollection<T extends { id: string }>(
  entityLabel: string,
  beforeRows: T[],
  afterRows: T[],
  describe: (row: T) => string,
  fields: Array<{ key: keyof T & string; label: string }>
): RecordDiff {
  const result = emptyDiff(entityLabel)
  const beforeMap = new Map(beforeRows.map((row) => [row.id, row]))
  const afterMap = new Map(afterRows.map((row) => [row.id, row]))

  afterRows.forEach((row) => {
    const before = beforeMap.get(row.id)
    if (!before) {
      result.added.push({ id: row.id, label: describe(row) })
    } else {
      const fieldsDiff = diffFields(before, row, fields)
      if (fieldsDiff.length > 0) {
        result.changed.push({ id: row.id, label: describe(row), fields: fieldsDiff })
      }
    }
  })
  beforeRows.forEach((row) => {
    if (!afterMap.has(row.id)) {
      result.removed.push({ id: row.id, label: describe(row) })
    }
  })
  return result
}

/**
 * 比对基底封存版（before）与复勘草稿（after），
 * 输出新增 / 删除 / 修改清单，供「基底已过期」变基与提交前核对使用。
 */
export function diffSnapshots(before: SealedSnapshot, after: SealedSnapshot): SnapshotDiff {
  const trench = diffFields(before.trench, after.trench, [
    { key: 'code', label: '探方号' },
    { key: 'area', label: '发掘区' },
    { key: 'size', label: '规格' },
    { key: 'basePoint', label: '基点坐标' },
    { key: 'openLayer', label: '开口层位' },
    { key: 'startDate', label: '发掘起始' },
    { key: 'endDate', label: '发掘结束' },
    { key: 'leader', label: '负责人' },
    { key: 'wallNote', label: '四壁备注' },
    { key: 'backfilled', label: '已回填' }
  ])
  const trenchDiff = emptyDiff('探方')
  if (trench.length > 0) {
    trenchDiff.changed.push({ id: after.trench.id, label: `${after.trench.area} · ${after.trench.code}`, fields: trench })
  }

  const strata = diffCollection(
    '地层单位',
    before.strata,
    after.strata,
    (row) => row.code,
    [
      { key: 'trenchId', label: '所属探方' },
      { key: 'code', label: '单位号' },
      { key: 'type', label: '类型' },
      { key: 'openLayer', label: '开口层位' },
      { key: 'topDepth', label: '上界深度' },
      { key: 'bottomDepth', label: '下界深度' },
      { key: 'soil', label: '土质土色' },
      { key: 'inclusions', label: '包含物' },
      { key: 'formation', label: '堆积成因' },
      { key: 'date', label: '日期' },
      { key: 'drawingNo', label: '绘图拍照号' }
    ]
  )

  const artifacts = diffCollection(
    '出土物',
    before.artifacts,
    after.artifacts,
    (row) => row.code,
    [
      { key: 'stratumId', label: '所属单位' },
      { key: 'code', label: '器物编号' },
      { key: 'category', label: '类别' },
      { key: 'count', label: '件数' },
      { key: 'completeness', label: '残整程度' },
      { key: 'x', label: 'X' },
      { key: 'y', label: 'Y' },
      { key: 'z', label: 'Z 深度' },
      { key: 'date', label: '出土日期' },
      { key: 'collector', label: '提取人' },
      { key: 'tempLocation', label: '临时存放' }
    ]
  )

  const relations = diffCollection(
    '层位关系',
    before.relations,
    after.relations,
    (row) => row.id,
    [
      { key: 'unitAId', label: '单位 A' },
      { key: 'type', label: '关系类型' },
      { key: 'unitBId', label: '单位 B' },
      { key: 'basis', label: '判定依据' },
      { key: 'recorder', label: '记录人' },
      { key: 'note', label: '备注' }
    ]
  )

  const hasChanges =
    trenchDiff.changed.length > 0 ||
    strata.added.length > 0 ||
    strata.removed.length > 0 ||
    strata.changed.length > 0 ||
    artifacts.added.length > 0 ||
    artifacts.removed.length > 0 ||
    artifacts.changed.length > 0 ||
    relations.added.length > 0 ||
    relations.removed.length > 0 ||
    relations.changed.length > 0

  return { hasChanges, trench: trenchDiff, strata, artifacts, relations }
}

/** 差异条目总数，用于摘要提示 */
export function diffSummary(diff: SnapshotDiff): string {
  const parts: string[] = []
  const count = (d: RecordDiff): number => d.added.length + d.removed.length + d.changed.length
  const push = (d: RecordDiff): void => {
    if (count(d) > 0) {
      parts.push(`${d.entityLabel} 新增 ${d.added.length}、删除 ${d.removed.length}、修改 ${d.changed.length}`)
    }
  }
  push(diff.strata)
  push(diff.artifacts)
  push(diff.relations)
  if (diff.trench.changed.length > 0) parts.push('探方信息有修改')
  return parts.length > 0 ? parts.join('；') : '无差异'
}
