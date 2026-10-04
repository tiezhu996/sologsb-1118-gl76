import type {
  ArchiveArtifact,
  ArchiveRelation,
  ArchiveStratum,
  ArchiveVersion,
  Artifact,
  Relation,
  Stratum,
  SurveyDraft,
  Trench
} from '@/types'
import { buildSnapshotRows, db } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import { buildWorkspaceDiff, hasConflicts, type WorkspaceDiff } from '@/utils/diff'

/** 提交时发现基底已过期：携带三方比对结果，草稿保留不动 */
export class StaleBaseError extends Error {
  head: ArchiveVersion
  base: ArchiveVersion
  diff: WorkspaceDiff
  constructor(base: ArchiveVersion, head: ArchiveVersion, diff: WorkspaceDiff) {
    super(`基底版本 v${base.versionNo} 已过期，最新封存版本为 v${head.versionNo}`)
    this.name = 'StaleBaseError'
    this.base = base
    this.head = head
    this.diff = diff
  }
}

/** 一个封存版本的完整数据束 */
export interface VersionBundle {
  version: ArchiveVersion
  trench: Trench
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** 复勘草稿的工作区数据束（与版本束同构，供比对） */
export interface DraftBundle {
  trench: Trench
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

async function loadVersionBundle(versionId: string): Promise<VersionBundle> {
  const version = await db.archiveVersions.get(versionId)
  if (!version) throw new Error(`封存版本 ${versionId} 不存在或已被清理`)
  const [snapStrata, snapArtifacts, snapRelations] = await Promise.all([
    db.archiveStrata.where('versionId').equals(versionId).toArray(),
    db.archiveArtifacts.where('versionId').equals(versionId).toArray(),
    db.archiveRelations.where('versionId').equals(versionId).toArray()
  ])
  return {
    version,
    trench: { ...version.trench },
    strata: snapStrata.map(restoreStratum),
    artifacts: snapArtifacts.map(restoreArtifact),
    relations: snapRelations.map(restoreRelation)
  }
}

function restoreStratum(row: ArchiveStratum): Stratum {
  return {
    id: row.originId,
    trenchId: row.trenchId,
    code: row.code,
    type: row.type,
    openLayer: row.openLayer,
    topDepth: row.topDepth,
    bottomDepth: row.bottomDepth,
    soil: row.soil,
    inclusions: [...row.inclusions],
    formation: row.formation,
    date: row.date,
    drawingNo: row.drawingNo
  }
}

function restoreArtifact(row: ArchiveArtifact): Artifact {
  return {
    id: row.originId,
    stratumId: row.stratumId,
    code: row.code,
    category: row.category,
    count: row.count,
    completeness: row.completeness,
    x: row.x,
    y: row.y,
    z: row.z,
    date: row.date,
    collector: row.collector,
    tempLocation: row.tempLocation
  }
}

function restoreRelation(row: ArchiveRelation): Relation {
  return {
    id: row.originId,
    unitAId: row.unitAId,
    type: row.type,
    unitBId: row.unitBId,
    basis: row.basis,
    recorder: row.recorder,
    note: row.note
  }
}

/** 现行工作区中一个探方的完整数据束 */
async function loadLiveBundle(trench: Trench): Promise<DraftBundle> {
  const units = await db.strata.where('trenchId').equals(trench.id).toArray()
  const unitIds = units.map((item) => item.id)
  const artifacts = await db.artifacts.where('stratumId').anyOf(unitIds.length > 0 ? unitIds : ['__none__']).toArray()
  const allRelations = await db.relations.toArray()
  const relations = allRelations.filter(
    (item) => unitIds.includes(item.unitAId) || unitIds.includes(item.unitBId)
  )
  return { trench: { ...trench }, strata: units, artifacts, relations }
}

/** 列出一个探方的全部封存版本（新 → 旧） */
export async function listVersions(trenchId: string): Promise<ArchiveVersion[]> {
  const versions = await db.archiveVersions.where('trenchId').equals(trenchId).toArray()
  return versions.sort((a, b) => b.versionNo - a.versionNo)
}

export async function getVersion(versionId: string): Promise<VersionBundle> {
  return loadVersionBundle(versionId)
}

/** 回填确认 → 首次封存：冻结探方与全部下属数据，写入 v1 */
export async function sealTrench(trench: Trench, note = '回填确认封存'): Promise<ArchiveVersion> {
  return db.transaction(
    'rw',
    [
      db.trenches,
      db.strata,
      db.artifacts,
      db.relations,
      db.archiveVersions,
      db.archiveStrata,
      db.archiveArtifacts,
      db.archiveRelations,
      db.drafts
    ],
    async () => {
      const live = await db.trenches.get(trench.id)
      if (!live) throw new Error('探方不存在，无法封存')
      const existing = await listVersions(live.id)
      if (existing.length > 0) throw new Error('该探方已有封存版本，复勘请从封存版开草稿后提交')
      const openDraft = (await db.drafts.where('trenchId').equals(live.id).toArray()).find(
        (item) => item.status === 'open'
      )
      if (openDraft) throw new Error('该探方存在进行中的复勘草稿，请先提交或放弃')

      const sealedTrench: Trench = { ...live, ...trench, backfilled: true }
      const bundle = await loadLiveBundle(sealedTrench)
      const versionId = uid('av')
      const rows = buildSnapshotRows(versionId, sealedTrench, bundle.strata, bundle.artifacts, bundle.relations)
      const version: ArchiveVersion = {
        id: versionId,
        trenchId: sealedTrench.id,
        versionNo: 1,
        parentId: '',
        trench: { ...sealedTrench },
        note,
        createdAt: new Date().toISOString()
      }
      await db.trenches.put(sealedTrench)
      await db.archiveVersions.put(version)
      if (rows.strata.length > 0) await db.archiveStrata.bulkPut(rows.strata)
      if (rows.artifacts.length > 0) await db.archiveArtifacts.bulkPut(rows.artifacts)
      if (rows.relations.length > 0) await db.archiveRelations.bulkPut(rows.relations)
      return version
    }
  )
}

/** 从封存版本开启复勘草稿；已有打开草稿则直接返回 */
export async function openDraft(versionId: string): Promise<SurveyDraft> {
  const version = await db.archiveVersions.get(versionId)
  if (!version) throw new Error('封存版本不存在')
  const existing = (await db.drafts.where('trenchId').equals(version.trenchId).toArray()).find(
    (item) => item.status === 'open'
  )
  if (existing) return existing

  const bundle = await loadVersionBundle(versionId)
  const now = new Date().toISOString()
  const draft: SurveyDraft = {
    id: uid('dr'),
    trenchId: version.trenchId,
    baseVersionId: version.id,
    baseVersionNo: version.versionNo,
    status: 'open',
    trench: { ...bundle.trench },
    strata: bundle.strata.map((item) => ({ ...item, inclusions: [...item.inclusions] })),
    artifacts: bundle.artifacts.map((item) => ({ ...item })),
    relations: bundle.relations.map((item) => ({ ...item })),
    createdAt: now,
    updatedAt: now,
    submittedVersionId: '',
    note: ''
  }
  await db.drafts.put(draft)
  return draft
}

/** 放弃草稿 */
export async function discardDraft(draftId: string): Promise<void> {
  const draft = await db.drafts.get(draftId)
  if (!draft) return
  await db.drafts.put({ ...draft, status: 'discarded', updatedAt: new Date().toISOString() })
}

/**
 * 提交复勘草稿（乐观锁）：
 * - 基底版本仍是该探方最新封存版 → 生成新版本，现行数据替换为草稿内容；
 * - 已有更新的封存版（另一标签页先提交）→ 抛 StaleBaseError，草稿保留。
 */
export async function commitDraft(
  draftId: string,
  note = '复勘改定封存'
): Promise<{ version: ArchiveVersion; draft: SurveyDraft }> {
  return db.transaction(
    'rw',
    [
      db.trenches,
      db.strata,
      db.artifacts,
      db.relations,
      db.archiveVersions,
      db.archiveStrata,
      db.archiveArtifacts,
      db.archiveRelations,
      db.drafts
    ],
    async () => {
      const draft = await db.drafts.get(draftId)
      if (!draft || draft.status !== 'open') throw new Error('草稿不存在或已结束，无法提交')

      const versions = await listVersions(draft.trenchId)
      const head = versions[0]
      const base = await db.archiveVersions.get(draft.baseVersionId)
      if (!base) throw new Error('草稿基底版本缺失')

      if (head && head.id !== draft.baseVersionId) {
        const [baseBundle, headBundle] = await Promise.all([
          loadVersionBundle(base.id),
          loadVersionBundle(head.id)
        ])
        const diff = buildWorkspaceDiff(baseBundle, headBundle, draft)
        throw new StaleBaseError(base, head, diff)
      }

      // 基底仍为最新 → 落新版本
      const versionNo = (head?.versionNo ?? 0) + 1
      const versionId = uid('av')
      const sealedTrench: Trench = { ...draft.trench, backfilled: true }
      const rows = buildSnapshotRows(versionId, sealedTrench, draft.strata, draft.artifacts, draft.relations)
      const version: ArchiveVersion = {
        id: versionId,
        trenchId: draft.trenchId,
        versionNo,
        parentId: base.id,
        trench: { ...sealedTrench },
        note,
        createdAt: new Date().toISOString()
      }

      await replaceLiveWithBundle(draft.trenchId, { trench: sealedTrench, strata: draft.strata, artifacts: draft.artifacts, relations: draft.relations })
      await db.archiveVersions.put(version)
      if (rows.strata.length > 0) await db.archiveStrata.bulkPut(rows.strata)
      if (rows.artifacts.length > 0) await db.archiveArtifacts.bulkPut(rows.artifacts)
      if (rows.relations.length > 0) await db.archiveRelations.bulkPut(rows.relations)

      const finished: SurveyDraft = {
        ...draft,
        status: 'submitted',
        submittedVersionId: version.id,
        updatedAt: version.createdAt,
        note
      }
      await db.drafts.put(finished)
      return { version, draft: finished }
    }
  )
}

/** 用草稿束替换现行表中该探方的数据（提交时调用，跨探方关系不受影响） */
async function replaceLiveWithBundle(
  trenchId: string,
  bundle: DraftBundle
): Promise<void> {
  const liveUnits = await db.strata.where('trenchId').equals(trenchId).toArray()
  const liveUnitIds = liveUnits.map((item) => item.id)
  const liveArtifacts = liveUnitIds.length
    ? await db.artifacts.where('stratumId').anyOf(liveUnitIds).toArray()
    : []
  const allRelations = await db.relations.toArray()
  const liveRelations = allRelations.filter(
    (item) => liveUnitIds.includes(item.unitAId) || liveUnitIds.includes(item.unitBId)
  )

  // 先清除旧数据，再写入草稿束。跨探方关系（另一端单位不在本探方）：
  // 草稿束中包含的按新值更新，其余原样保留
  const draftRelationIds = new Set(bundle.relations.map((item) => item.id))
  const staleCrossRelations = liveRelations.filter(
    (item) => !draftRelationIds.has(item.id)
  )

  await db.artifacts.bulkDelete(liveArtifacts.map((item) => item.id))
  await db.relations.bulkDelete(staleCrossRelations.map((item) => item.id))
  await db.strata.bulkDelete(liveUnitIds)

  await db.trenches.put(bundle.trench)
  await db.strata.bulkPut(bundle.strata)
  await db.artifacts.bulkPut(bundle.artifacts)
  await db.relations.bulkPut(bundle.relations)
}

/**
 * Re-base：把草稿基底切换到最新封存版本，自动合入「仅最新版改动」的部分；
 * 双方都改了同一字段的冲突保留草稿值并在返回值中标出，供记录员比对后调整。
 */
export async function rebaseDraft(
  draftId: string
): Promise<{ draft: SurveyDraft; diff: WorkspaceDiff; conflicts: boolean }> {
  const draft = await db.drafts.get(draftId)
  if (!draft || draft.status !== 'open') throw new Error('草稿不可用，无法 rebase')
  const versions = await listVersions(draft.trenchId)
  const head = versions[0]
  if (!head) throw new Error('缺少最新封存版本')
  if (head.id === draft.baseVersionId) {
    const baseBundle = await loadVersionBundle(draft.baseVersionId)
    return { draft, diff: buildWorkspaceDiff(baseBundle, baseBundle, draft), conflicts: false }
  }
  const [baseBundle, headBundle] = await Promise.all([
    loadVersionBundle(draft.baseVersionId),
    loadVersionBundle(head.id)
  ])

  const merged = mergeBundles(baseBundle, headBundle, draft)
  const next: SurveyDraft = {
    ...draft,
    ...merged,
    baseVersionId: head.id,
    baseVersionNo: head.versionNo,
    updatedAt: new Date().toISOString()
  }
  await db.drafts.put(next)
  const diff = buildWorkspaceDiff(baseBundle, headBundle, next)
  return { draft: next, diff, conflicts: hasConflicts(diff) }
}

type AnyEntity = Record<string, unknown>

/** 逐字段三方合并：无冲突字段取非基底的新值，冲突字段保留草稿值（标记待人工裁决） */
function mergeEntity(base: AnyEntity | undefined, head: AnyEntity | undefined, draft: AnyEntity | undefined): AnyEntity | undefined {
  if (draft && !base && !head) return { ...draft } // 草稿新增
  if (!draft && base && !head) return undefined // 草稿删除，head 未涉及 → 维持删除
  if (draft && base && !head) return { ...draft } // 仅草稿改动
  if (!draft && base && head) return { ...head } // 草稿未动、head 改/删：以 head 为准（head 删除时返回 undefined）
  if (!draft && !base && head) return { ...head } // head 新增，草稿未涉及
  if (!draft || !head || !base) return draft ?? head
  // 三方都在：逐字段合并
  const out: AnyEntity = { ...head }
  Object.keys(draft).forEach((key) => {
    const b = normalizeScalar(base[key])
    const h = normalizeScalar(head[key])
    const d = normalizeScalar(draft[key])
    if (h === b) {
      // 最新版未改此字段 → 取草稿值
      out[key] = draft[key]
    } else if (d !== b) {
      // 双方都改：保留草稿值，交由人工裁决
      out[key] = draft[key]
    }
    // 否则 head 已改、草稿未改 → 保留 head 值
  })
  return out
}

function normalizeScalar(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  return value === undefined || value === null ? '' : String(value)
}

function mergeBundles(base: VersionBundle, head: VersionBundle, draft: SurveyDraft): DraftBundle {
  const mergeCollections = <T extends { id: string }>(baseRows: T[], headRows: T[], draftRows: T[]): T[] => {
    const byId = (rows: T[]): Map<string, T> => new Map(rows.map((row) => [row.id, row]))
    const b = byId(baseRows)
    const h = byId(headRows)
    const d = byId(draftRows)
    const ids = new Set<string>([...b.keys(), ...h.keys(), ...d.keys()])
    const out: T[] = []
    ids.forEach((id) => {
      const merged = mergeEntity(b.get(id) as AnyEntity | undefined, h.get(id) as AnyEntity | undefined, d.get(id) as AnyEntity | undefined)
      if (merged) out.push({ ...(merged as object) } as T)
    })
    return out
  }

  const trench = mergeEntity(
    { ...base.trench, id: base.trench.id } as AnyEntity,
    { ...head.trench, id: head.trench.id } as AnyEntity,
    { ...draft.trench, id: draft.trench.id } as AnyEntity
  ) as unknown as Trench

  return {
    trench,
    strata: mergeCollections(base.strata, head.strata, draft.strata),
    artifacts: mergeCollections(base.artifacts, head.artifacts, draft.artifacts),
    relations: mergeCollections(base.relations, head.relations, draft.relations)
  }
}
