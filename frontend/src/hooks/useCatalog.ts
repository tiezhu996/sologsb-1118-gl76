import { computed } from 'vue'
import type { Artifact, Relation, Stratum, SurveyDraft, Trench } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { archiveStore } from '@/stores/archiveStore'
import {
  draftBulkSetStratumType,
  draftRemoveArtifact,
  draftRemoveRelation,
  draftRemoveStratum,
  draftSaveArtifact,
  draftSaveRelation,
  draftSaveStratum,
  draftSaveTrench
} from '@/stores/archiveStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'

/** 写入被拒绝时的错误（封存只读） */
export class ReadonlyArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadonlyArchiveError'
  }
}

/**
 * 编目数据统一门面：
 * - 现行数据 = live 表；某探方存在打开的复勘草稿时，该探方的视图以草稿工作区替换；
 * - 封存探方（有版本、无打开草稿）默认只读；
 * - 所有写入都经过此门面，页面不直接调用底层 store 的写方法。
 */
export function useCatalog() {
  const trenchState = useStore(trenchStore)
  const stratumState = useStore(stratumStore)
  const artifactState = useStore(artifactStore)
  const relationState = useStore(relationStore)
  const archiveState = useStore(archiveStore)

  const openDrafts = computed(() => archiveState.drafts.filter((item) => item.status === 'open'))

  /** trenchId → 打开草稿 */
  const draftByTrench = computed(() => {
    const map = new Map<string, SurveyDraft>()
    openDrafts.value.forEach((draft) => map.set(draft.trenchId, draft))
    return map
  })

  const isSealed = (trenchId: string): boolean =>
    archiveState.versions.some((item) => item.trenchId === trenchId)

  const isReadonly = (trenchId: string): boolean => isSealed(trenchId) && !draftByTrench.value.has(trenchId)

  const draftOf = (trenchId: string): SurveyDraft | undefined => draftByTrench.value.get(trenchId)

  /** 视图数据：打开草稿中的探方以草稿工作区覆盖 live */
  const trenches = computed<Trench[]>(() =>
    trenchState.trenches.map((item) => draftByTrench.value.get(item.id)?.trench ?? item)
  )

  const strata = computed<Stratum[]>(() => {
    const draftTrenchIds = new Set(openDrafts.value.map((item) => item.trenchId))
    const live = stratumState.strata.filter((item) => !draftTrenchIds.has(item.trenchId))
    const draftRows = openDrafts.value.flatMap((draft) => draft.strata)
    return [...draftRows, ...live]
  })

  const artifacts = computed<Artifact[]>(() => {
    const draftUnitIds = new Set(openDrafts.value.flatMap((draft) => draft.strata.map((item) => item.id)))
    const live = artifactState.artifacts.filter((item) => !draftUnitIds.has(item.stratumId))
    const draftRows = openDrafts.value.flatMap((draft) => draft.artifacts)
    return [...draftRows, ...live]
  })

  const relations = computed<Relation[]>(() => {
    const draftUnitIds = new Set(
      openDrafts.value.flatMap((draft) => draft.strata.map((item) => item.id))
    )
    const draftRelationIds = new Set(openDrafts.value.flatMap((draft) => draft.relations.map((item) => item.id)))
    const live = relationState.relations.filter(
      (item) =>
        !draftRelationIds.has(item.id) &&
        !(draftUnitIds.has(item.unitAId) || draftUnitIds.has(item.unitBId))
    )
    const draftRows = openDrafts.value.flatMap((draft) => draft.relations)
    return [...draftRows, ...live]
  })

  function assertWritable(trenchId: string): SurveyDraft | undefined {
    const draft = draftByTrench.value.get(trenchId)
    if (draft) return draft
    if (isSealed(trenchId)) {
      throw new ReadonlyArchiveError('该探方已回填封存，页面为只读；如需修改请从封存版开启复勘草稿')
    }
    return undefined
  }

  const saveTrench = async (trench: Trench): Promise<void> => {
    const draft = draftByTrench.value.get(trench.id)
    if (draft) {
      await draftSaveTrench(draft, trench)
      return
    }
    if (isSealed(trench.id)) {
      throw new ReadonlyArchiveError('封存探方不可直接编辑，请先开启复勘草稿')
    }
    await trenchStore.getState().save(trench)
  }

  const saveStratum = async (stratum: Stratum): Promise<void> => {
    const draft = assertWritable(stratum.trenchId)
    if (draft) await draftSaveStratum(draft, stratum)
    else await stratumStore.getState().save(stratum)
  }

  const removeStratum = async (id: string): Promise<void> => {
    const owner = strata.value.find((item) => item.id === id)
    if (!owner) return
    const draft = assertWritable(owner.trenchId)
    if (draft) await draftRemoveStratum(draft, id)
    else await stratumStore.getState().remove(id)
  }

  const bulkSetStratumType = async (ids: string[], type: Stratum['type']): Promise<void> => {
    if (ids.length === 0) return
    // 批量操作只允许落在同一个写上下文（live 或同一草稿）
    const owners = new Set(
      ids.map((id) => strata.value.find((item) => item.id === id)?.trenchId).filter(Boolean)
    )
    if (owners.size > 1) throw new ReadonlyArchiveError('批量调整仅限同一探方内的单位（封存探方需先开复勘草稿）')
    const trenchId = [...owners][0] as string
    const draft = assertWritable(trenchId)
    if (draft) await draftBulkSetStratumType(draft, ids, type)
    else await stratumStore.getState().bulkSetType(ids, type)
  }

  const saveArtifact = async (artifact: Artifact): Promise<void> => {
    const unit = strata.value.find((item) => item.id === artifact.stratumId)
    if (!unit) throw new Error('所属地层单位不存在')
    const draft = assertWritable(unit.trenchId)
    if (draft) await draftSaveArtifact(draft, artifact)
    else await artifactStore.getState().save(artifact)
  }

  const removeArtifact = async (id: string): Promise<void> => {
    const row = artifacts.value.find((item) => item.id === id)
    if (!row) return
    const unit = strata.value.find((item) => item.id === row.stratumId)
    const draft = unit ? assertWritable(unit.trenchId) : undefined
    if (draft) await draftRemoveArtifact(draft, id)
    else await artifactStore.getState().remove(id)
  }

  const saveRelation = async (relation: Relation): Promise<void> => {
    const unitA = strata.value.find((item) => item.id === relation.unitAId)
    const unitB = strata.value.find((item) => item.id === relation.unitBId)
    const trenchId = unitA?.trenchId ?? unitB?.trenchId
    if (!trenchId) throw new Error('层位关系的单位不存在')
    const draft = assertWritable(trenchId)
    if (draft) await draftSaveRelation(draft, relation)
    else await relationStore.getState().save(relation)
  }

  const removeRelation = async (id: string): Promise<void> => {
    const row = relations.value.find((item) => item.id === id)
    if (!row) return
    const unitA = strata.value.find((item) => item.id === row.unitAId)
    const unitB = strata.value.find((item) => item.id === row.unitBId)
    const trenchId = unitA?.trenchId ?? unitB?.trenchId
    const draft = trenchId ? assertWritable(trenchId) : undefined
    if (draft) await draftRemoveRelation(draft, id)
    else await relationStore.getState().remove(id)
  }

  return {
    // 原始 store（页面仍需用其 loaded 等状态）
    trenchState,
    stratumState,
    artifactState,
    relationState,
    archiveState,
    // 合并后的只读视图
    trenches,
    strata,
    artifacts,
    relations,
    // 封存/草稿状态
    isSealed,
    isReadonly,
    draftOf,
    openDrafts,
    // 写门面
    saveTrench,
    saveStratum,
    removeStratum,
    bulkSetStratumType,
    saveArtifact,
    removeArtifact,
    saveRelation,
    removeRelation
  }
}
