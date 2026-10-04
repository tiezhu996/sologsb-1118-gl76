import { createStore } from 'zustand/vanilla'
import type { Trench } from '@/types'
import { db, notifyDataChange, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sealStore } from '@/stores/sealStore'

export interface TrenchState {
  trenches: Trench[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (trench: Trench) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const trenchStore = createStore<TrenchState>((set, get) => ({
  trenches: [],
  loaded: false,
  hydrate: async () => {
    const trenches = await syncAll<Trench>(db.trenches)
    trenches.sort((a, b) => `${a.area}${a.code}`.localeCompare(`${b.area}${b.code}`, 'zh-Hans-CN'))
    set({ trenches, loaded: true })
  },
  save: async (trench) => {
    // 已封存探方只读，回填标记也不允许在普通编辑里改动（回填确认 = 封存新版本）
    sealStore.getState().assertWritable(trench.id)
    await syncPut<Trench>(db.trenches, trench)
    await get().hydrate()
    notifyDataChange('trench')
  },
  remove: async (id) => {
    sealStore.getState().assertWritable(id)
    await syncDelete<Trench>(db.trenches, id)
    await get().hydrate()
    notifyDataChange('trench')
  }
}))
