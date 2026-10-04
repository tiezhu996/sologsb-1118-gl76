import type { ArchiveVersion } from '@/types'

/** 单个字段的三方取值 */
export interface FieldDiff {
  key: string
  label: string
  /** 基底版本中的值 */
  base: string
  /** 最新封存版本中的值（另一个标签页已提交的结果） */
  head: string
  /** 当前草稿中的值 */
  draft: string
  /** 是否三方各不相同/草稿与最新版冲突 */
  conflicting: boolean
}

/** 一条实体的比对结果 */
export interface EntityDiff {
  originId: string
  /** 行展示名（单位号/器物编号/关系描述） */
  label: string
  /** added 草稿新增；removed 草稿删除；modified 草稿相对基底改动；headChanged 仅最新版改动（草稿未涉及） */
  status: 'added' | 'removed' | 'modified' | 'headChanged' | 'unchanged'
  /** 整行级冲突：如草稿删除但最新版修改、草稿修改但最新版删除 */
  rowConflict: boolean
  fields: FieldDiff[]
}

/** 一整个探方工作区的比对结果 */
export interface WorkspaceDiff {
  trench: EntityDiff
  strata: EntityDiff[]
  artifacts: EntityDiff[]
  relations: EntityDiff[]
}

/** 归一化后的实体：稳定身份 + 字段文本字典 */
interface NormalEntity {
  originId: string
  label: string
  fields: Map<string, string>
}

const EMPTY = '—'

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : EMPTY
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

/** 把任意实体行归一化为 originId + 字段字典 */
function normalize(
  row: Record<string, unknown> & { originId?: string; id?: string },
  labelOf: (row: Record<string, unknown>) => string,
  fieldKeys: string[]
): NormalEntity {
  const originId = String(row.originId ?? row.id ?? '')
  const fields = new Map<string, string>()
  fieldKeys.forEach((key) => fields.set(key, text(row[key])))
  return { originId, label: labelOf(row), fields }
}

function diffEntity(
  base: NormalEntity | undefined,
  head: NormalEntity | undefined,
  draft: NormalEntity | undefined,
  allKeys: { key: string; label: string }[]
): EntityDiff | null {
  const present = draft ?? head ?? base
  if (!present) return null

  const draftChangedFromBase = (entity: NormalEntity): boolean =>
    allKeys.some((f) => (base?.fields.get(f.key) ?? EMPTY) !== (entity.fields.get(f.key) ?? EMPTY))
  const headChangedFromBase = (entity: NormalEntity): boolean =>
    allKeys.some((f) => (base?.fields.get(f.key) ?? EMPTY) !== (entity.fields.get(f.key) ?? EMPTY))

  let status: EntityDiff['status']
  if (draft && !base) status = 'added'
  else if (!draft && base) status = 'removed'
  else if (draft && base && draftChangedFromBase(draft)) status = 'modified'
  else if (head && headChangedFromBase(head)) status = 'headChanged'
  else if (head && !base && !draft) status = 'headChanged'
  else status = 'unchanged'

  const fields: FieldDiff[] = allKeys.map((f) => {
    const b = base?.fields.get(f.key) ?? EMPTY
    const h = head?.fields.get(f.key) ?? EMPTY
    const d = draft?.fields.get(f.key) ?? EMPTY
    // 仅最新版相对基底发生变化、且草稿也与最新版不一致时，才是需要人工裁决的冲突
    const headTouched = h !== b
    const draftTouched = d !== b
    let conflicting = false
    if (headTouched && draftTouched && h !== d) conflicting = true
    // 草稿删除 vs 最新版修改、草稿修改 vs 最新版删除，整行冲突
    if ((!draft && head && headTouched) || (draft && !head && draftTouched && base)) conflicting = true
    return { key: f.key, label: f.label, base: b, head: h, draft: d, conflicting }
  })

  // 整行级冲突：草稿删除 vs 最新版修改、草稿修改 vs 最新版删除
  const draftRowChanged = (draft && !base) || (!draft && base) || (draft && base && draftChangedFromBase(draft))
  const headRowChanged = (head && !base) || (!head && base) || (head && base && headChangedFromBase(head))
  const rowConflict = Boolean(draftRowChanged && headRowChanged && status !== 'added')

  if (status === 'unchanged') return null
  return { originId: present.originId, label: present.label, status, rowConflict, fields }
}

function diffCollection(
  baseRows: NormalEntity[],
  headRows: NormalEntity[],
  draftRows: NormalEntity[],
  fieldSpec: { key: string; label: string }[]
): EntityDiff[] {
  const toMap = (rows: NormalEntity[]): Map<string, NormalEntity> => new Map(rows.map((row) => [row.originId, row]))
  const baseMap = toMap(baseRows)
  const headMap = toMap(headRows)
  const draftMap = toMap(draftRows)

  const ids = new Set<string>([...baseMap.keys(), ...headMap.keys(), ...draftMap.keys()])
  const result: EntityDiff[] = []
  ids.forEach((id) => {
    const diff = diffEntity(baseMap.get(id), headMap.get(id), draftMap.get(id), fieldSpec)
    if (diff) result.push(diff)
  })
  const weight = { added: 0, removed: 1, modified: 2, headChanged: 3, unchanged: 4 }
  result.sort((a, b) => {
    const conflictGap =
      Number(b.rowConflict || b.fields.some((f) => f.conflicting)) -
      Number(a.rowConflict || a.fields.some((f) => f.conflicting))
    return conflictGap || weight[a.status] - weight[b.status] || a.label.localeCompare(b.label, 'zh-Hans-CN')
  })
  return result
}

/** 字段规格（与各业务模型一一对应） */
const TRENCH_FIELDS = [
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
]

const STRATUM_FIELDS = [
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

const ARTIFACT_FIELDS = [
  { key: 'code', label: '器物编号' },
  { key: 'stratumId', label: '所属单位' },
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

const RELATION_FIELDS = [
  { key: 'unitAId', label: '单位 A' },
  { key: 'type', label: '关系' },
  { key: 'unitBId', label: '单位 B' },
  { key: 'basis', label: '判定依据' },
  { key: 'recorder', label: '记录人' },
  { key: 'note', label: '备注' }
]

type AnyRow = Record<string, unknown>

/** 比对输入束：只要求形状（trench/strata/artifacts/relations），接受具体业务类型 */
export interface BundleLike {
  trench: AnyRow
  strata: readonly AnyRow[]
  artifacts: readonly AnyRow[]
  relations: readonly AnyRow[]
}

/** 任意符合形状的束（VersionBundle / SurveyDraft 等可直接传入） */
type BundleInput = {
  trench: object
  strata: readonly object[]
  artifacts: readonly object[]
  relations: readonly object[]
}

/**
 * 三方比对：基底版本 vs 最新封存版本（他人已提交）vs 当前草稿。
 * unitLabel 用于把关系/出土物里的单位 id 渲染成单位号。
 */
export function buildWorkspaceDiff(base: BundleInput, head: BundleInput, draft: BundleInput): WorkspaceDiff {
  const b = base as unknown as BundleLike
  const h = head as unknown as BundleLike
  const d = draft as unknown as BundleLike
  const unitNames = new Map<string, string>()
  const collectNames = (bundle: BundleLike): void => {
    bundle.strata.forEach((row) => unitNames.set(String(row.originId ?? row.id), String(row.code)))
  }
  collectNames(b)
  collectNames(h)
  collectNames(d)
  const unitLabel = (id: unknown): string => unitNames.get(String(id)) ?? String(id ?? EMPTY)

  const norm = (
    rows: readonly AnyRow[],
    spec: { key: string; label: string }[],
    labelOf: (row: AnyRow) => string
  ): NormalEntity[] => rows.map((row) => normalize(row, labelOf, spec.map((f) => f.key)))

  const trenchLabelOf = (row: AnyRow): string => `${text(row.area)} · ${text(row.code)}`
  const codeLabelOf = (row: AnyRow): string => text(row.code)
  const artifactLabelOf = (row: AnyRow): string => `${text(row.code)}（${unitLabel(row.stratumId)}）`
  const relationLabelOf = (row: AnyRow): string => `${unitLabel(row.unitAId)} ${text(row.type)} ${unitLabel(row.unitBId)}`

  // 出土物/关系中的单位 id 在字段文本里渲染为单位号
  const withUnitNames = (rows: readonly AnyRow[], keys: string[]): AnyRow[] =>
    rows.map((row) => {
      const clone: AnyRow = { ...row }
      keys.forEach((key) => {
        if (clone[key] !== undefined) clone[key] = unitLabel(clone[key])
      })
      return clone
    })

  const trenchDiff =
    diffCollection(
      norm([b.trench], TRENCH_FIELDS, trenchLabelOf),
      norm([h.trench], TRENCH_FIELDS, trenchLabelOf),
      norm([d.trench], TRENCH_FIELDS, trenchLabelOf),
      TRENCH_FIELDS
    )[0] ?? emptyTrenchDiff(b, h, d)

  return {
    trench: trenchDiff,
    strata: diffCollection(
      norm(b.strata, STRATUM_FIELDS, codeLabelOf),
      norm(h.strata, STRATUM_FIELDS, codeLabelOf),
      norm(d.strata, STRATUM_FIELDS, codeLabelOf),
      STRATUM_FIELDS
    ),
    artifacts: diffCollection(
      norm(withUnitNames(b.artifacts, ['stratumId']), ARTIFACT_FIELDS, artifactLabelOf),
      norm(withUnitNames(h.artifacts, ['stratumId']), ARTIFACT_FIELDS, artifactLabelOf),
      norm(withUnitNames(d.artifacts, ['stratumId']), ARTIFACT_FIELDS, artifactLabelOf),
      ARTIFACT_FIELDS
    ),
    relations: diffCollection(
      norm(withUnitNames(b.relations, ['unitAId', 'unitBId']), RELATION_FIELDS, relationLabelOf),
      norm(withUnitNames(h.relations, ['unitAId', 'unitBId']), RELATION_FIELDS, relationLabelOf),
      norm(withUnitNames(d.relations, ['unitAId', 'unitBId']), RELATION_FIELDS, relationLabelOf),
      RELATION_FIELDS
    )
  }
}

function emptyTrenchDiff(base: BundleLike, head: BundleLike, draft: BundleLike): EntityDiff {
  return {
    originId: String(draft.trench.id ?? head.trench.id ?? base.trench.id ?? ''),
    label: `${text(draft.trench.area ?? head.trench.area)} · ${text(draft.trench.code ?? head.trench.code)}`,
    status: 'unchanged',
    rowConflict: false,
    fields: []
  }
}

/** 比对结果中是否存在需要人工裁决的冲突（字段级或整行级） */
export function hasConflicts(diff: WorkspaceDiff): boolean {
  const all = [diff.trench, ...diff.strata, ...diff.artifacts, ...diff.relations]
  return all.some((entity) => entity.rowConflict || entity.fields.some((field) => field.conflicting))
}

/** 供提交过期异常引用的版本信息（避免循环依赖，结构化即可） */
export type VersionHead = Pick<ArchiveVersion, 'id' | 'versionNo' | 'createdAt' | 'note'>
