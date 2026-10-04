import { createStore } from 'zustand/vanilla'
import type { ReworkDraft, SealedSnapshot, SealedVersion, Trench } from '@/types'
import { db, notifyDataChange, syncAll } from '@/hooks/usePersistentStore'
import { TrenchFrozenError, BaseStaleError } from '@/utils/errors'
import { cloneSnapshot, makeSnapshot } from '@/utils/snapshot'
import { uid } from '@/utils/id'

/** 某探方最新封存版本（无封存返回 null） */
async function headVersion(trenchId: string): Promise<SealedVersion | null> {
  const rows = await db.sealedVersions.where('trenchId').equals(trenchId).toArray()
  if (rows.length === 0) return null
  return rows.reduce((latest, item) => (item.versionNo > latest.versionNo ? item : latest))
}

export interface SealState {
  versions: SealedVersion[]
  drafts: ReworkDraft[]
  loaded: boolean
  hydrate: () => Promise<void>
  versionsOf: (trenchId: string) => SealedVersion[]
  latestVersionOf: (trenchId: string) => SealedVersion | null
  draftOf: (trenchId: string) => ReworkDraft | null
  isSealed: (trenchId: string) => boolean
  /** 已封存探方一律只读；复勘修改只能走复勘草稿 */
  assertWritable: (trenchId: string) => void
  /** 回填确认：冻结探方及全部地层单位、出土物、层位关系，生成第一版封存 */
  sealTrench: (input: { trenchId: string; sealedBy: string; note: string }) => Promise<SealedVersion>
  /** 从封存版开启复勘草稿（工作副本为封存快照的克隆） */
  openDraft: (input: { trenchId: string; createdBy: string; reason: string }) => Promise<ReworkDraft>
  /** 修改草稿工作副本（工作台各编辑面板统一走这里） */
  mutateDraft: (draftId: string, mutator: (draft: ReworkDraft) => void) => Promise<ReworkDraft>
  discardDraft: (draftId: string) => Promise<void>
  /**
   * 提交复勘草稿：在事务内核验基底版本号。
   * 若其他标签页已提交过新版本（基底过期），抛出 BaseStaleError，草稿保留。
   */
  commitDraft: (draftId: string, input: { sealedBy: string; note: string }) => Promise<SealedVersion>
}

export const sealStore = createStore<SealState>((set, get) => ({
  versions: [],
  drafts: [],
  loaded: false,

  hydrate: async () => {
    const [versions, drafts] = await Promise.all([
      syncAll<SealedVersion>(db.sealedVersions),
      syncAll<ReworkDraft>(db.reworkDrafts)
    ])
    versions.sort((a, b) =>
      a.trenchId === b.trenchId ? a.versionNo - b.versionNo : a.trenchId.localeCompare(b.trenchId)
    )
    drafts.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    set({ versions, drafts, loaded: true })
  },

  versionsOf: (trenchId) =>
    get()
      .versions.filter((item) => item.trenchId === trenchId)
      .sort((a, b) => b.versionNo - a.versionNo),

  latestVersionOf: (trenchId) => {
    const list = get().versions.filter((item) => item.trenchId === trenchId)
    return list.reduce<SealedVersion | null>(
      (latest, item) => (latest && latest.versionNo >= item.versionNo ? latest : item),
      null
    )
  },

  draftOf: (trenchId) => get().drafts.find((item) => item.trenchId === trenchId) ?? null,

  isSealed: (trenchId) => get().versions.some((item) => item.trenchId === trenchId),

  assertWritable: (trenchId) => {
    if (get().versions.some((item) => item.trenchId === trenchId)) {
      throw new TrenchFrozenError(trenchId)
    }
  },

  sealTrench: async ({ trenchId, sealedBy, note }) => {
    const createdId: { value: SealedVersion | null } = { value: null }
    await db.transaction(
      'rw',
      [db.trenches, db.strata, db.artifacts, db.relations, db.sealedVersions, db.reworkDrafts],
      async () => {
        const trench = await db.trenches.get(trenchId)
        if (!trench) throw new Error('探方不存在，无法封存')
        if ((await headVersion(trenchId)) !== null) {
          throw new Error('该探方已有封存版本，复勘请从封存版开启草稿')
        }
        if ((await db.reworkDrafts.where('trenchId').equals(trenchId).count()) > 0) {
          throw new Error('该探方已有进行中的复勘草稿，请先提交或放弃')
        }
        const strata = await db.strata.where('trenchId').equals(trenchId).toArray()
        const unitIds = new Set(strata.map((item) => item.id))
        const [artifacts, relations] = await Promise.all([db.artifacts.toArray(), db.relations.toArray()])
        const sealedTrench: Trench = { ...trench, backfilled: true }
        const snapshot: SealedSnapshot = makeSnapshot({
          trench: sealedTrench,
          strata,
          artifacts: artifacts.filter((item) => unitIds.has(item.stratumId)),
          relations: relations.filter((item) => unitIds.has(item.unitAId) || unitIds.has(item.unitBId))
        })
        const version: SealedVersion = {
          id: uid('sv'),
          trenchId,
          versionNo: 1,
          sealedAt: new Date().toISOString(),
          sealedBy: sealedBy.trim() || '记录员',
          note: note.trim() || '回填确认封存',
          snapshot
        }
        await db.trenches.put(sealedTrench)
        await db.sealedVersions.put(version)
        createdId.value = version
      }
    )
    await get().hydrate()
    notifyDataChange('seal')
    return createdId.value as SealedVersion
  },

  openDraft: async ({ trenchId, createdBy, reason }) => {
    const base = get().latestVersionOf(trenchId)
    if (!base) throw new Error('该探方尚未封存，无法开启复勘草稿')
    const existing = get().draftOf(trenchId)
    if (existing) return existing
    const draft: ReworkDraft = {
      id: uid('rd'),
      trenchId,
      baseVersionNo: base.versionNo,
      openedVersionNo: base.versionNo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: createdBy.trim() || '记录员',
      reason: reason.trim() || '回填后复勘修正',
      work: cloneSnapshot(base.snapshot)
    }
    await db.reworkDrafts.put(draft)
    await get().hydrate()
    notifyDataChange('seal')
    return draft
  },

  mutateDraft: async (draftId, mutator) => {
    const current = await db.reworkDrafts.get(draftId)
    if (!current) throw new Error('复勘草稿不存在（可能已在其他标签页提交）')
    mutator(current)
    current.updatedAt = new Date().toISOString()
    await db.reworkDrafts.put(current)
    await get().hydrate()
    notifyDataChange('seal')
    return current
  },

  discardDraft: async (draftId) => {
    await db.reworkDrafts.delete(draftId)
    await get().hydrate()
    notifyDataChange('seal')
  },

  commitDraft: async (draftId, { sealedBy, note }) => {
    const createdId: { value: SealedVersion | null } = { value: null }
    let stale: BaseStaleError | null = null
    await db.transaction(
      'rw',
      [db.trenches, db.strata, db.artifacts, db.relations, db.sealedVersions, db.reworkDrafts],
      async () => {
        const draft = await db.reworkDrafts.get(draftId)
        if (!draft) throw new Error('复勘草稿不存在（可能已提交或被放弃）')
        const head = await headVersion(draft.trenchId)
        if (!head || head.versionNo !== draft.baseVersionNo) {
          // 基底已过期：保留草稿，不写入任何变更，由记录员比对后变基重交
          stale = new BaseStaleError(draft.trenchId, draft.baseVersionNo, head?.versionNo ?? 0)
          return
        }

        const snapshot: SealedSnapshot = cloneSnapshot(draft.work)
        snapshot.trench = { ...snapshot.trench, backfilled: true }

        const version: SealedVersion = {
          id: uid('sv'),
          trenchId: draft.trenchId,
          versionNo: head.versionNo + 1,
          sealedAt: new Date().toISOString(),
          sealedBy: sealedBy.trim() || draft.createdBy,
          note: note.trim() || `复勘第 ${head.versionNo + 1} 版`,
          snapshot
        }

        // 用工作副本整组替换该探方的实时表数据
        const liveStrata = await db.strata.where('trenchId').equals(draft.trenchId).toArray()
        const snapshotUnitIds = new Set(snapshot.strata.map((item) => item.id))
        // 清理范围同时覆盖草稿中已删除、新增的单位，避免留下孤儿记录
        const scopeUnitIds = new Set([
          ...liveStrata.map((item) => item.id),
          ...snapshotUnitIds
        ])
        const [liveArtifacts, liveRelations] = await Promise.all([
          db.artifacts.toArray(),
          db.relations.toArray()
        ])

        await db.trenches.put(snapshot.trench)
        await Promise.all(
          liveStrata.filter((item) => !snapshotUnitIds.has(item.id)).map((item) => db.strata.delete(item.id))
        )
        await db.strata.bulkPut(snapshot.strata)

        await Promise.all(
          liveArtifacts
            .filter((item) => scopeUnitIds.has(item.stratumId))
            .map((item) => db.artifacts.delete(item.id))
        )
        await db.artifacts.bulkPut(snapshot.artifacts)

        await Promise.all(
          liveRelations
            .filter((item) => scopeUnitIds.has(item.unitAId) || scopeUnitIds.has(item.unitBId))
            .map((item) => db.relations.delete(item.id))
        )
        await db.relations.bulkPut(snapshot.relations)

        await db.sealedVersions.put(version)
        await db.reworkDrafts.delete(draft.id)
        createdId.value = version
      }
    )

    if (stale) throw stale
    if (!createdId.value) throw new Error('复勘提交未生成新版本，请重试')
    await get().hydrate()
    notifyDataChange('seal')
    return createdId.value
  }
}))
