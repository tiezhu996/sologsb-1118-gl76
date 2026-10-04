import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table, type Transaction } from 'dexie'
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

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：现行表 + 封存快照表 + 复勘草稿表 + 元数据表 */
class TrenchLogDb extends Dexie {
  trenches!: Table<Trench, string>
  strata!: Table<Stratum, string>
  artifacts!: Table<Artifact, string>
  relations!: Table<Relation, string>
  archiveVersions!: Table<ArchiveVersion, string>
  archiveStrata!: Table<ArchiveStratum, string>
  archiveArtifacts!: Table<ArchiveArtifact, string>
  archiveRelations!: Table<ArchiveRelation, string>
  drafts!: Table<SurveyDraft, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbtrenchlog')
    this.version(1).stores({
      trenches: 'id, code, area',
      strata: 'id, trenchId, code, type',
      artifacts: 'id, stratumId, code, category',
      relations: 'id, unitAId, unitBId, type',
      meta: 'key'
    })
    // v2：地层单位新增「开口层位」字段，迁移时为历史数据补齐默认值
    this.version(2).stores({
      trenches: 'id, code, area, backfilled',
      strata: 'id, trenchId, code, type, topDepth',
      artifacts: 'id, stratumId, code, category, date',
      relations: 'id, unitAId, unitBId, type, basis',
      meta: 'key'
    })
    // v3：回填封存版本体系。新增五张表，升级时为已回填探方补第一版封存
    this.version(SCHEMA_VERSION)
      .stores({
        trenches: 'id, code, area, backfilled',
        strata: 'id, trenchId, code, type, topDepth',
        artifacts: 'id, stratumId, code, category, date',
        relations: 'id, unitAId, unitBId, type, basis',
        archiveVersions: 'id, trenchId, versionNo, parentId, createdAt',
        archiveStrata: 'id, originId, versionId, trenchId',
        archiveArtifacts: 'id, originId, versionId, trenchId, stratumId',
        archiveRelations: 'id, originId, versionId, trenchId, unitAId, unitBId',
        drafts: 'id, trenchId, baseVersionId, status, updatedAt',
        meta: 'key'
      })
      .upgrade((tx) => migrateBackfilledArchives(tx))
  }
}

export const db = new TrenchLogDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.archiveVersions.count() // 触发延迟打开，确保升级已执行
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand vanilla store → Vue 响应式桥接 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/**
 * 由现行数据为一个探方构造封存快照行（纯函数，供首次封存与 v3 升级迁移复用）。
 * 关系纳入规则：A、B 任一单位属于该探方即冻结进此版本。
 */
export function buildSnapshotRows(
  versionId: string,
  trench: Trench,
  strata: Stratum[],
  artifacts: Artifact[],
  relations: Relation[]
): { strata: ArchiveStratum[]; artifacts: ArchiveArtifact[]; relations: ArchiveRelation[] } {
  const unitIds = new Set(strata.map((item) => item.id))
  const snapStrata: ArchiveStratum[] = strata.map(({ id, ...rest }) => ({
    ...rest,
    id: `${versionId}:${id}`,
    originId: id,
    versionId,
    trenchId: trench.id
  }))
  const snapArtifacts: ArchiveArtifact[] = artifacts
    .filter((item) => unitIds.has(item.stratumId))
    .map(({ id, ...rest }) => ({
      ...rest,
      id: `${versionId}:${id}`,
      originId: id,
      versionId,
      trenchId: trench.id
    }))
  const snapRelations: ArchiveRelation[] = relations
    .filter((item) => unitIds.has(item.unitAId) || unitIds.has(item.unitBId))
    .map(({ id, ...rest }) => ({
      ...rest,
      id: `${versionId}:${id}`,
      originId: id,
      versionId,
      trenchId: trench.id
    }))
  return { strata: snapStrata, artifacts: snapArtifacts, relations: snapRelations }
}

/**
 * v3 升级：为升级前已回填、且尚无任何封存版本的探方补第一版封存。
 * 必须在升级事务内调用（tx 来自 Dexie 的 upgrade 回调）。
 */
export async function migrateBackfilledArchives(tx: Transaction): Promise<void> {
  const trenchesTable = tx.table<Trench, string>('trenches')
  const strataTable = tx.table<Stratum, string>('strata')
  const artifactsTable = tx.table<Artifact, string>('artifacts')
  const relationsTable = tx.table<Relation, string>('relations')
  const versionsTable = tx.table<ArchiveVersion, string>('archiveVersions')
  const archiveStrataTable = tx.table<ArchiveStratum, string>('archiveStrata')
  const archiveArtifactsTable = tx.table<ArchiveArtifact, string>('archiveArtifacts')
  const archiveRelationsTable = tx.table<ArchiveRelation, string>('archiveRelations')

  const [trenches, allStrata, allArtifacts, allRelations, existing] = await Promise.all([
    trenchesTable.toArray(),
    strataTable.toArray(),
    artifactsTable.toArray(),
    relationsTable.toArray(),
    versionsTable.toArray()
  ])

  const sealedTrenchIds = new Set(existing.map((item) => item.trenchId))
  const stamp = new Date().toISOString()

  for (const trench of trenches) {
    if (!trench.backfilled || sealedTrenchIds.has(trench.id)) continue
    const versionId = `av_${trench.id}_v1`
    const units = allStrata.filter((item) => item.trenchId === trench.id)
    const rows = buildSnapshotRows(versionId, trench, units, allArtifacts, allRelations)
    const version: ArchiveVersion = {
      id: versionId,
      trenchId: trench.id,
      versionNo: 1,
      parentId: '',
      trench: { ...trench },
      note: '数据升级补封（回填探方第一版封存）',
      createdAt: stamp
    }
    await versionsTable.put(version)
    if (rows.strata.length > 0) await archiveStrataTable.bulkPut(rows.strata)
    if (rows.artifacts.length > 0) await archiveArtifactsTable.bulkPut(rows.artifacts)
    if (rows.relations.length > 0) await archiveRelationsTable.bulkPut(rows.relations)
  }
}

/** 首次打开写入示例数据：回填示例探方同时落第一版封存 */
export async function seedDemoData(): Promise<void> {
  const count = await db.trenches.count()
  if (count > 0) return

  const today = new Date().toISOString().slice(0, 10)

  const trenches: Trench[] = [
    {
      id: 'tr_0501',
      code: 'T0501',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1200 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: '',
      leader: '方铭',
      wallNote: '北壁、东壁保存较好；南壁被现代扰坑破坏',
      backfilled: false
    },
    {
      id: 'tr_0502',
      code: 'T0502',
      area: 'Ⅱ区',
      size: '5×5 米',
      basePoint: 'N1205 / E3000',
      openLayer: '第①层',
      startDate: today,
      endDate: today,
      leader: '方铭',
      wallNote: '四壁规整，西壁可见 H12 剖面',
      backfilled: true
    }
  ]

  const strata: Stratum[] = [
    {
      id: 'st_0501_l1',
      trenchId: 'tr_0501',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.25,
      soil: '灰褐色砂质黏土，疏松',
      inclusions: ['陶片', '炭屑'],
      formation: '近现代耕土层',
      date: today,
      drawingNo: 'T0501-北壁-01'
    },
    {
      id: 'st_0501_l2',
      trenchId: 'tr_0501',
      code: 'L02',
      type: '地层',
      openLayer: '第②层',
      topDepth: 0.25,
      bottomDepth: 0.6,
      soil: '黄褐色黏土，致密',
      inclusions: ['陶片', '骨'],
      formation: '汉代文化层',
      date: today,
      drawingNo: 'T0501-北壁-02'
    },
    {
      id: 'st_0501_h12',
      trenchId: 'tr_0501',
      code: 'H12',
      type: '灰坑',
      openLayer: '第②层下',
      topDepth: 0.6,
      bottomDepth: 1.4,
      soil: '深灰褐土，含大量灰烬',
      inclusions: ['陶片', '骨', '炭屑'],
      formation: '生活垃圾坑',
      date: today,
      drawingNo: 'T0501-H12-平剖面'
    },
    {
      id: 'st_0502_l1',
      trenchId: 'tr_0502',
      code: 'L01',
      type: '地层',
      openLayer: '第①层',
      topDepth: 0,
      bottomDepth: 0.3,
      soil: '灰褐色砂质黏土',
      inclusions: ['陶片'],
      formation: '耕土层',
      date: today,
      drawingNo: 'T0502-西壁-01'
    }
  ]

  const artifacts: Artifact[] = [
    {
      id: 'af_001',
      stratumId: 'st_0501_l2',
      code: 'T0501②:1',
      category: '陶器',
      count: 3,
      completeness: '残片',
      x: 2.4,
      y: 1.8,
      z: 0.42,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-2'
    },
    {
      id: 'af_002',
      stratumId: 'st_0501_h12',
      code: 'T0501H12:1',
      category: '骨器',
      count: 1,
      completeness: '可复原',
      x: 3.1,
      y: 3.6,
      z: 1.05,
      date: today,
      collector: '祁野',
      tempLocation: '工地临时柜 A-3'
    }
  ]

  const relations: Relation[] = [
    {
      id: 'rl_001',
      unitAId: 'st_0501_h12',
      type: '打破',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'H12 开口于第②层下，打破 L02'
    },
    {
      id: 'rl_002',
      unitAId: 'st_0501_l1',
      type: '叠压',
      unitBId: 'st_0501_l2',
      basis: '剖面观察',
      recorder: '方铭',
      note: 'L01 叠压 L02，界面清晰'
    }
  ]

  await db.transaction(
    'rw',
    [
      db.trenches,
      db.strata,
      db.artifacts,
      db.relations,
      db.archiveVersions,
      db.archiveStrata,
      db.archiveArtifacts,
      db.archiveRelations
    ],
    async () => {
    await db.trenches.bulkPut(trenches)
    await db.strata.bulkPut(strata)
    await db.artifacts.bulkPut(artifacts)
    await db.relations.bulkPut(relations)

    // 回填示例探方（T0502）直接生成第一版封存，保持「已回填即有封存」不变式
    const sealed = trenches.filter((item) => item.backfilled)
    for (const trench of sealed) {
      const versionId = `av_${trench.id}_v1`
      const units = strata.filter((item) => item.trenchId === trench.id)
      const rows = buildSnapshotRows(versionId, trench, units, artifacts, relations)
      await db.archiveVersions.put({
        id: versionId,
        trenchId: trench.id,
        versionNo: 1,
        parentId: '',
        trench: { ...trench },
        note: '回填确认封存（示例数据第一版）',
        createdAt: new Date().toISOString()
      })
      if (rows.strata.length > 0) await db.archiveStrata.bulkPut(rows.strata)
      if (rows.artifacts.length > 0) await db.archiveArtifacts.bulkPut(rows.artifacts)
      if (rows.relations.length > 0) await db.archiveRelations.bulkPut(rows.relations)
    }
  })
}
