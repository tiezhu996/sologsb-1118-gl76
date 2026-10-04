import { createStore } from 'zustand/vanilla'
import type { ArchiveVersion, Artifact, Relation, Stratum, SurveyDraft, Trench } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'

export interface ArchiveState {
  versions: ArchiveVersion[]
  drafts: SurveyDraft[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 直接保存草稿（各编辑动作修改工作区后统一落库） */
  saveDraft: (draft: SurveyDraft) => Promise<void>
  /** 探方当前进行中的草稿（无则 undefined） */
  openDraftOf: (trenchId: string) => SurveyDraft | undefined
  /** 探方最新封存版本（无则 undefined） */
  latestVersionOf: (trenchId: string) => ArchiveVersion | undefined
}

/** 在草稿工作区上执行修改并落库 */
async function mutateDraft(
  draft: SurveyDraft,
  recipe: (next: SurveyDraft) => void
): Promise<SurveyDraft> {
  const next: SurveyDraft = structuredClone(draft)
  recipe(next)
  next.updatedAt = new Date().toISOString()
  await db.drafts.put(next)
  archiveStore.getState().hydrate()
  return next
}

export const archiveStore = createStore<ArchiveState>((set, get) => ({
  versions: [],
  drafts: [],
  loaded: false,
  hydrate: async () => {
    const [versions, drafts] = await Promise.all([db.archiveVersions.toArray(), db.drafts.toArray()])
    versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({ versions, drafts, loaded: true })
  },
  saveDraft: async (draft) => {
    await db.drafts.put({ ...draft, updatedAt: new Date().toISOString() })
    await get().hydrate()
  },
  openDraftOf: (trenchId) =>
    get().drafts.find((item) => item.trenchId === trenchId && item.status === 'open'),
  latestVersionOf: (trenchId) =>
    get()
      .versions.filter((item) => item.trenchId === trenchId)
      .sort((a, b) => b.versionNo - a.versionNo)[0]
}))

/** 草稿工作区写操作：探方 */
export async function draftSaveTrench(draft: SurveyDraft, trench: Trench): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    next.trench = { ...trench, id: draft.trenchId, backfilled: true }
  })
}

/** 草稿工作区写操作：地层单位 */
export async function draftSaveStratum(draft: SurveyDraft, stratum: Stratum): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    const id = stratum.id || uid('st')
    const row: Stratum = { ...stratum, id, trenchId: draft.trenchId }
    const index = next.strata.findIndex((item) => item.id === id)
    if (index >= 0) next.strata[index] = row
    else next.strata.push(row)
  })
}

export async function draftRemoveStratum(draft: SurveyDraft, stratumId: string): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    next.strata = next.strata.filter((item) => item.id !== stratumId)
    next.artifacts = next.artifacts.filter((item) => item.stratumId !== stratumId)
    next.relations = next.relations.filter((item) => item.unitAId !== stratumId && item.unitBId !== stratumId)
  })
}

export async function draftBulkSetStratumType(
  draft: SurveyDraft,
  ids: string[],
  type: Stratum['type']
): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    next.strata = next.strata.map((item) => (ids.includes(item.id) ? { ...item, type } : item))
  })
}

/** 草稿工作区写操作：出土物（单位必须属于本草稿探方） */
export async function draftSaveArtifact(draft: SurveyDraft, artifact: Artifact): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    if (!next.strata.some((item) => item.id === artifact.stratumId)) {
      throw new Error('出土物所属地层单位不在本复勘草稿工作区内')
    }
    const id = artifact.id || uid('af')
    const index = next.artifacts.findIndex((item) => item.id === id)
    if (index >= 0) next.artifacts[index] = { ...artifact, id }
    else next.artifacts.push({ ...artifact, id })
  })
}

export async function draftRemoveArtifact(draft: SurveyDraft, artifactId: string): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    next.artifacts = next.artifacts.filter((item) => item.id !== artifactId)
  })
}

/** 草稿工作区写操作：层位关系（任一端单位属于本草稿探方即可） */
export async function draftSaveRelation(draft: SurveyDraft, relation: Relation): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    const own = (id: string): boolean => next.strata.some((item) => item.id === id)
    if (!own(relation.unitAId) && !own(relation.unitBId)) {
      throw new Error('层位关系两端单位均不在本复勘草稿工作区内')
    }
    const id = relation.id || uid('rl')
    const index = next.relations.findIndex((item) => item.id === id)
    if (index >= 0) next.relations[index] = { ...relation, id }
    else next.relations.push({ ...relation, id })
  })
}

export async function draftRemoveRelation(draft: SurveyDraft, relationId: string): Promise<SurveyDraft> {
  return mutateDraft(draft, (next) => {
    next.relations = next.relations.filter((item) => item.id !== relationId)
  })
}
