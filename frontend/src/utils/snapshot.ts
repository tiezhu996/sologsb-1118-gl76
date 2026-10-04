import type { Artifact, Relation, SealedSnapshot, Stratum, Trench } from '@/types'

/** 深拷贝快照（数据均为可 JSON 序列化的档案记录） */
export function cloneSnapshot(snapshot: SealedSnapshot): SealedSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as SealedSnapshot
}

/** 由实时表数据组装某探方的完整快照 */
export function makeSnapshot(input: {
  trench: Trench
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}): SealedSnapshot {
  return cloneSnapshot({
    trench: input.trench,
    strata: input.strata,
    artifacts: input.artifacts,
    relations: input.relations
  })
}

/** 快照内容是否一致（忽略封存元信息，只比档案本体） */
export function snapshotEqual(a: SealedSnapshot, b: SealedSnapshot): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/** 规整排序后再比较，避免数组成员相同但顺序不同造成误判 */
function normalize(snapshot: SealedSnapshot): SealedSnapshot {
  const byId = (x: { id: string }, y: { id: string }): number => x.id.localeCompare(y.id)
  return {
    trench: snapshot.trench,
    strata: [...snapshot.strata].sort(byId),
    artifacts: [...snapshot.artifacts].sort(byId),
    relations: [...snapshot.relations].sort(byId)
  }
}

/** 在快照内按 id 查地层单位号 */
export function unitCodeIn(snapshot: SealedSnapshot, unitId: string): string {
  return snapshot.strata.find((item) => item.id === unitId)?.code ?? '未知单位'
}

/** 实时表过滤某探方的相关记录（与封存快照口径一致） */
export function filterTrenchRecords(input: {
  trenchId: string
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}): { strata: Stratum[]; artifacts: Artifact[]; relations: Relation[] } {
  const strata = input.strata.filter((item) => item.trenchId === input.trenchId)
  const unitIds = new Set(strata.map((item) => item.id))
  return {
    strata,
    artifacts: input.artifacts.filter((item) => unitIds.has(item.stratumId)),
    relations: input.relations.filter((item) => unitIds.has(item.unitAId) || unitIds.has(item.unitBId))
  }
}
