/**
 * 封存版本体系端到端逻辑验证（Node + fake-indexeddb）。
 * 运行：npx tsx scripts/verify-archive.ts
 * 覆盖：回填封存 → 只读 → 开草稿 → 正常提交 → 双标签乐观锁冲突 → rebase 重交 → 旧版可读 → 升级补封。
 */
import { IDBFactory } from 'fake-indexeddb'
import 'fake-indexeddb/auto'
import { beforeEach, beforeEach as setupGlobal } from 'node:test'

void beforeEach
void setupGlobal

// 每次运行前清库
indexedDB = new IDBFactory() as unknown as IDBFactory

process.env.TZ = 'UTC'

// 动态导入确保使用上面注入的 indexedDB
const store = await import('../src/hooks/usePersistentStore.ts')
const archive = await import('../src/services/archiveService.ts')
const archiveStoreModule = await import('../src/stores/archiveStore.ts')
const { db, seedDemoData, stampDbVersion, SCHEMA_VERSION } = store
const { sealTrench, openDraft, commitDraft, rebaseDraft, listVersions, getVersion, StaleBaseError } = archive
const { archiveStore, draftSaveStratum, draftSaveArtifact, draftSaveRelation, draftRemoveStratum } =
  archiveStoreModule

let passed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

async function snapshotCounts(): Promise<void> {
  const [trenches, strata, artifacts, relations, versions, s1, s2, s3, drafts] = await Promise.all([
    db.trenches.count(),
    db.strata.count(),
    db.artifacts.count(),
    db.relations.count(),
    db.archiveVersions.count(),
    db.archiveStrata.count(),
    db.archiveArtifacts.count(),
    db.archiveRelations.count(),
    db.drafts.count()
  ])
  console.log(
    `  counts: trenches=${trenches} strata=${strata} artifacts=${artifacts} relations=${relations} versions=${versions} snapStrata=${s1} snapArtifacts=${s2} snapRelations=${s3} drafts=${drafts}`
  )
}

// ---- 1. 启动 & 示例数据：回填探方 T0502 自带 v1 封存 ----
await seedDemoData()
await stampDbVersion()
check('SCHEMA_VERSION = 3', SCHEMA_VERSION === 3)
await snapshotCounts()

const versions0502 = await listVersions('tr_0502')
check('回填示例探方 T0502 有第一版封存', versions0502.length === 1 && versions0502[0].versionNo === 1)
const v0502 = await getVersion(versions0502[0].id)
check('v1 快照冻结 1 个地层单位', v0502.strata.length === 1 && v0502.strata[0].code === 'L01')

const versions0501 = await listVersions('tr_0501')
check('未回填探方 T0501 无封存', versions0501.length === 0)

// ---- 2. T0501 回填确认封存 → v1 ----
const tr0501 = await db.trenches.get('tr_0501')
const sealedV1 = await sealTrench(tr0501!, '回填确认封存-测试')
check('T0501 封存 v1', sealedV1.versionNo === 1)
await archiveStore.getState().hydrate()
const live0501 = await db.trenches.get('tr_0501')
check('封存后现行探方 backfilled=true', live0501!.backfilled === true)
const bundleV1 = await getVersion(sealedV1.id)
check('v1 冻结 3 单位/2 出土物/2 关系', bundleV1.strata.length === 3 && bundleV1.artifacts.length === 2 && bundleV1.relations.length === 2)

// ---- 3. 草稿 A 与草稿 B 并发（模拟两个标签页）----
const draftA = await openDraft(sealedV1.id)
// 第二个标签页若再开草稿会拿到同一个进行中草稿（单草稿约束）；
// 并发场景由「先提交」触发，这里用 A 提交、B=同一基底的克隆来模拟
await archiveStore.getState().hydrate()

// 标签页 A：改正 H12 深度下界 1.4 → 1.55
const h12 = draftA.strata.find((s) => s.code === 'H12')!
await draftSaveStratum(draftA, { ...h12, bottomDepth: 1.55 })

// 标签页 B：基于同一 v1 独立开一份草稿（绕过单草稿约束，模拟真两标签页各自的内存状态）
const draftBRaw = await openDraft(sealedV1.id) // 拿到 A
// 手工构造 B 的独立草稿行，直接写 drafts 表（模拟另一标签页在 A 提交前已打开）
const draftBId = 'dr_sim_B'
await db.drafts.put({
  ...draftBRaw,
  id: draftBId,
  strata: draftBRaw.strata.map((s) => ({ ...s, inclusions: [...s.inclusions] })),
  artifacts: draftBRaw.artifacts.map((a) => ({ ...a })),
  relations: draftBRaw.relations.map((r) => ({ ...r }))
})
const draftB = (await db.drafts.get(draftBId))!
// B 修改 L02 的土质土色
const l2 = draftB.strata.find((s) => s.code === 'L02')!
await db.drafts.put({ ...draftB, strata: draftB.strata.map((s) => (s.id === l2.id ? { ...s, soil: '黄褐色黏土，致密，含少量料姜石' } : s)) })

// ---- 4. A 先提交成功 → v2 ----
const { version: v2 } = await commitDraft(draftA.id, '复勘：H12 深度修正')
check('A 提交生成 v2', v2.versionNo === 2 && v2.parentId === sealedV1.id)
await archiveStore.getState().hydrate()
const liveH12 = await db.strata.get(h12.id)
check('现行库 H12 下界已更新为 1.55', liveH12!.bottomDepth === 1.55)

// ---- 5. B 后提交 → 基底过期，抛 StaleBaseError 且草稿保留 ----
let staleError: InstanceType<typeof StaleBaseError> | null = null
try {
  await commitDraft(draftBId, '复勘：L02 土质修正')
} catch (e) {
  staleError = e as InstanceType<typeof StaleBaseError>
}
check('B 提交被拒：基底已过期', staleError instanceof StaleBaseError)
check('过期错误指向最新 v2', staleError?.head.versionNo === 2)
const stillOpen = await db.drafts.get(draftBId)
check('B 的草稿被保留（仍 open）', stillOpen?.status === 'open')
const diff = staleError!.diff
check('比对包含 H12（最新版已改）', diff.strata.some((d) => d.label === 'H12'))
check('比对包含 L02（草稿修改）', diff.strata.some((d) => d.label === 'L02'))

// ---- 6. B rebase 到 v2 后重交 → v3 ----
const rebased = await rebaseDraft(draftBId)
check('rebase 后基底切到 v2', rebased.draft.baseVersionNo === 2)
check(
  'rebase 自动并入 H12=1.55 且保留 L02 修改',
  rebased.draft.strata.find((s) => s.code === 'H12')!.bottomDepth === 1.55 &&
    rebased.draft.strata.find((s) => s.code === 'L02')!.soil.includes('料姜石')
)
const { version: v3 } = await commitDraft(draftBId, '复勘：L02 土质修正（已并入 v2）')
check('B 重交生成 v3', v3.versionNo === 3 && v3.parentId === v2.id)

// ---- 7. 旧版仍可查看导出（快照不可变）----
const oldV1 = await getVersion(sealedV1.id)
const oldV2 = await getVersion(v2.id)
const newV3 = await getVersion(v3.id)
check('v1 仍冻结旧 H12=1.4', oldV1.strata.find((s) => s.code === 'H12')!.bottomDepth === 1.4)
check('v2 冻结 H12=1.55、L02 旧土质', oldV2.strata.find((s) => s.code === 'H12')!.bottomDepth === 1.55 && !oldV2.strata.find((s) => s.code === 'L02')!.soil.includes('料姜石'))
check('v3 同时含 H12=1.55 与 L02 新土质', newV3.strata.find((s) => s.code === 'H12')!.bottomDepth === 1.55 && newV3.strata.find((s) => s.code === 'L02')!.soil.includes('料姜石'))
check('现行库最终与 v3 一致', (await db.strata.get(h12.id))!.bottomDepth === 1.55 && (await db.strata.get(l2.id))!.soil.includes('料姜石'))

// ---- 8. 草稿工作区增/删实体并提交 ----
let draftC = await openDraft(v3.id)
const { uid } = await import('../src/utils/id.ts')
draftC = await draftSaveArtifact(draftC, {
  id: uid('af'),
  stratumId: h12.id,
  code: 'T0501H12:9',
  category: '陶器',
  count: 2,
  completeness: '残片',
  x: 1,
  y: 1,
  z: 1.2,
  date: '2026-10-01',
  collector: '测试',
  tempLocation: ''
})
draftC = await draftRemoveStratum(draftC, draftC.strata.find((s) => s.code === 'L01')!.id)
const { version: v4 } = await commitDraft(draftC.id, '补出土物、删 L01')
const bundleV4 = await getVersion(v4.id)
check('v4 新增出土物', bundleV4.artifacts.some((a) => a.code === 'T0501H12:9'))
check('v4 删除 L01（单位 2 个）', bundleV4.strata.length === 2 && !bundleV4.strata.some((s) => s.code === 'L01'))
// L01 删除后其出土物/关系应级联清除
check('删除单位级联清理关系（L01 叠压 L02 已移除）', !bundleV4.relations.some((r) => r.unitAId === 'st_0501_l1'))
check(
  '现行库 L01 与关联关系已移除',
  !(await db.strata.get('st_0501_l1')) && !(await db.relations.get('rl_002'))
)
// v1/v2/v3 里的 L01 仍在（不可变）
check('旧版 v3 中 L01 仍在（封存不可变）', (await getVersion(v3.id)).strata.some((s) => s.code === 'L01'))

// ---- 9. 封存后重复封存被拒 ----
let sealAgainOk = true
try {
  await sealTrench((await db.trenches.get('tr_0501'))!)
} catch {
  sealAgainOk = false
}
check('已有封存版后不能再次直接封存', !sealAgainOk)

// ---- 10. 升级补封：模拟旧库（v2 数据，已回填但无封存）升级到 v3 ----
// 用一个全新库手工播种「v2 时代」数据，再用 Dexie v2→v3 升级
{
  indexedDB = new IDBFactory() as unknown as IDBFactory
  const Dexie = (await import('dexie')).default
  // 先以 v2 结构建库写入
  const oldDb = new Dexie('gbtrenchlog_legacy')
  oldDb.version(2).stores({
    trenches: 'id, code, area, backfilled',
    strata: 'id, trenchId, code, type, topDepth',
    artifacts: 'id, stratumId, code, category, date',
    relations: 'id, unitAId, unitBId, type, basis',
    meta: 'key'
  })
  await oldDb.open()
  await oldDb.table('trenches').put({
    id: 'legacy_1', code: 'T9999', area: 'Ⅰ区', size: '5×5 米', basePoint: '',
    openLayer: '第①层', startDate: '2020-01-01', endDate: '2020-02-01', leader: '', wallNote: '', backfilled: true
  })
  await oldDb.table('strata').put({
    id: 'legacy_s1', trenchId: 'legacy_1', code: 'L01', type: '地层', openLayer: '第①层',
    topDepth: 0, bottomDepth: 0.4, soil: '黄土', inclusions: ['陶片'], formation: '', date: '', drawingNo: ''
  })
  await oldDb.table('meta').put({ key: 'schemaVersion', value: 2 })
  await oldDb.close()

  // 用同名库以当前 schema 打开，触发 v3 upgrade
  const upgraded = new Dexie('gbtrenchlog_legacy')
  upgraded
    .version(2)
    .stores({
      trenches: 'id, code, area, backfilled',
      strata: 'id, trenchId, code, type, topDepth',
      artifacts: 'id, stratumId, code, category, date',
      relations: 'id, unitAId, unitBId, type, basis',
      meta: 'key'
    })
  const { migrateBackfilledArchives } = await import('../src/hooks/usePersistentStore.ts')
  upgraded.version(3).stores({
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
  }).upgrade((tx) => migrateBackfilledArchives(tx as never))
  await upgraded.open()
  const legacyVersions = await upgraded.table('archiveVersions').where('trenchId').equals('legacy_1').toArray()
  check('升级后已回填探方补第一版封存', legacyVersions.length === 1 && legacyVersions[0].versionNo === 1)
  const legacySnap = await upgraded.table('archiveStrata').where('versionId').equals(legacyVersions[0].id).toArray()
  check('补封包含历史地层单位', legacySnap.length === 1 && legacySnap[0].originId === 'legacy_s1')
  await upgraded.close()
}

console.log(`\n${passed} 项检查通过`)
