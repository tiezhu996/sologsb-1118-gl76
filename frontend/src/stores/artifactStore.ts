import { createStore } from 'zustand/vanilla'
import type { Artifact } from '@/types'
import { db, notifyDataChange, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { sealStore } from '@/stores/sealStore'
import { stratumStore } from '@/stores/stratumStore'

/** 出土物所属地层单位 → 所属探方（封存放行到探方粒度） */
function trenchIdOfStratum(stratumId: string): string | null {
  return stratumStore.getState().strata.find((item) => item.id === stratumId)?.trenchId ?? null
}

export interface ArtifactState {
  artifacts: Artifact[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (artifact: Artifact) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByStratum: (stratumId: string) => Promise<void>
}

export const artifactStore = createStore<ArtifactState>((set, get) => ({
  artifacts: [],
  loaded: false,
  hydrate: async () => {
    const artifacts = await syncAll<Artifact>(db.artifacts)
    artifacts.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ artifacts, loaded: true })
  },
  save: async (artifact) => {
    const trenchId = trenchIdOfStratum(artifact.stratumId)
    if (trenchId) sealStore.getState().assertWritable(trenchId)
    await syncPut<Artifact>(db.artifacts, artifact)
    await get().hydrate()
    notifyDataChange('artifact')
  },
  remove: async (id) => {
    const target = get().artifacts.find((item) => item.id === id)
    const trenchId = target ? trenchIdOfStratum(target.stratumId) : null
    if (trenchId) sealStore.getState().assertWritable(trenchId)
    await syncDelete<Artifact>(db.artifacts, id)
    await get().hydrate()
    notifyDataChange('artifact')
  },
  removeByStratum: async (stratumId) => {
    const trenchId = trenchIdOfStratum(stratumId)
    if (trenchId) sealStore.getState().assertWritable(trenchId)
    const targets = get().artifacts.filter((item) => item.stratumId === stratumId)
    await Promise.all(targets.map((item) => syncDelete<Artifact>(db.artifacts, item.id)))
    await get().hydrate()
    notifyDataChange('artifact')
  }
}))
