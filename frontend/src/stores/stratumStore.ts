import { createStore } from 'zustand/vanilla'
import type { Stratum, UnitType } from '@/types'
import { db, notifyDataChange, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sealStore } from '@/stores/sealStore'

export interface StratumState {
  strata: Stratum[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (stratum: Stratum) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetType: (ids: string[], type: UnitType) => Promise<void>
}

export const stratumStore = createStore<StratumState>((set, get) => ({
  strata: [],
  loaded: false,
  hydrate: async () => {
    const strata = await syncAll<Stratum>(db.strata)
    strata.sort((a, b) => (a.topDepth === b.topDepth ? a.code.localeCompare(b.code, 'zh-Hans-CN') : a.topDepth - b.topDepth))
    set({ strata, loaded: true })
  },
  save: async (stratum) => {
    sealStore.getState().assertWritable(stratum.trenchId)
    await syncPut<Stratum>(db.strata, stratum)
    await get().hydrate()
    notifyDataChange('stratum')
  },
  remove: async (id) => {
    const target = get().strata.find((item) => item.id === id)
    if (target) sealStore.getState().assertWritable(target.trenchId)
    await syncDelete<Stratum>(db.strata, id)
    await get().hydrate()
    notifyDataChange('stratum')
  },
  bulkSetType: async (ids, type) => {
    const targets = get().strata.filter((item) => ids.includes(item.id))
    // 批量调整不允许跨封存探方，命中任一封存探方即整批拒绝
    targets.forEach((item) => sealStore.getState().assertWritable(item.trenchId))
    await Promise.all(targets.map((item) => syncPut<Stratum>(db.strata, { ...item, type })))
    await get().hydrate()
    notifyDataChange('stratum')
  }
}))
