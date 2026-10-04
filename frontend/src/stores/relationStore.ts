import { createStore } from 'zustand/vanilla'
import type { Relation } from '@/types'
import { db, notifyDataChange, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sealStore } from '@/stores/sealStore'
import { stratumStore } from '@/stores/stratumStore'

/** 层位关系两端单位所属探方（通常同探方，封存校验两侧都放行到探方粒度） */
function trenchIdsOfRelation(unitAId: string, unitBId: string): string[] {
  const strata = stratumStore.getState().strata
  const ids = [unitAId, unitBId]
    .map((unitId) => strata.find((item) => item.id === unitId)?.trenchId)
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set(ids))
}

export interface RelationState {
  relations: Relation[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 保存前由页面做环路检测，store 只负责写入与封存只读守卫 */
  save: (relation: Relation) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByStratum: (stratumId: string) => Promise<void>
}

export const relationStore = createStore<RelationState>((set, get) => ({
  relations: [],
  loaded: false,
  hydrate: async () => {
    const relations = await syncAll<Relation>(db.relations)
    relations.sort((a, b) => a.id.localeCompare(b.id))
    set({ relations, loaded: true })
  },
  save: async (relation) => {
    trenchIdsOfRelation(relation.unitAId, relation.unitBId).forEach((trenchId) =>
      sealStore.getState().assertWritable(trenchId)
    )
    await syncPut<Relation>(db.relations, relation)
    await get().hydrate()
    notifyDataChange('relation')
  },
  remove: async (id) => {
    const target = get().relations.find((item) => item.id === id)
    if (target) {
      trenchIdsOfRelation(target.unitAId, target.unitBId).forEach((trenchId) =>
        sealStore.getState().assertWritable(trenchId)
      )
    }
    await syncDelete<Relation>(db.relations, id)
    await get().hydrate()
    notifyDataChange('relation')
  },
  removeByStratum: async (stratumId) => {
    const stratum = stratumStore.getState().strata.find((item) => item.id === stratumId)
    if (stratum) sealStore.getState().assertWritable(stratum.trenchId)
    const targets = get().relations.filter((item) => item.unitAId === stratumId || item.unitBId === stratumId)
    await Promise.all(targets.map((item) => syncDelete<Relation>(db.relations, item.id)))
    await get().hydrate()
    notifyDataChange('relation')
  }
}))
