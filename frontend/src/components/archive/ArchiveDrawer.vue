<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ArchiveVersion, Artifact, Stratum } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { archiveStore } from '@/stores/archiveStore'
import {
  discardDraft,
  getVersion,
  listVersions,
  openDraft,
  type VersionBundle
} from '@/services/archiveService'
import { downloadJson, downloadCsv } from '@/utils/export'
import { emitArchiveEvent } from '@/hooks/useArchiveEvents'

const props = defineProps<{ modelValue: boolean; trenchId: string; trenchLabel: string }>()
const emit = defineEmits<{ (event: 'update:modelValue', value: boolean): void; (event: 'draft-opened'): void }>()

const archiveState = useStore(archiveStore)

const versions = ref<ArchiveVersion[]>([])
const viewing = ref<VersionBundle | null>(null)
const loading = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const openDraftRow = computed(() =>
  archiveState.drafts.find((item) => item.trenchId === props.trenchId && item.status === 'open')
)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    versions.value = await listVersions(props.trenchId)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.trenchId] as const,
  ([open]) => {
    if (open) {
      viewing.value = null
      void refresh()
    }
  },
  { immediate: true }
)

async function view(version: ArchiveVersion): Promise<void> {
  viewing.value = await getVersion(version.id)
}

async function startDraft(version: ArchiveVersion): Promise<void> {
  if (openDraftRow.value && openDraftRow.value.baseVersionId !== version.id) {
    ElMessage.warning(
      `已有基于 v${openDraftRow.value.baseVersionNo} 的复勘草稿进行中，请先提交或放弃后再选择其他版本`
    )
    return
  }
  await ElMessageBox.confirm(
    `从封存版 v${version.versionNo} 开启复勘草稿？工作区将冻结为可编辑，封存版本身保持不变。`,
    '开启复勘草稿',
    { type: 'info', confirmButtonText: '开启草稿' }
  )
  const draft = await openDraft(version.id)
  await archiveStore.getState().hydrate()
  emitArchiveEvent('draft-opened', { trenchId: draft.trenchId, draftId: draft.id })
  ElMessage.success(`已基于 v${version.versionNo} 开启复勘草稿，可到各编目页修改后提交`)
  emit('draft-opened')
  emit('update:modelValue', false)
}

async function abandonDraft(): Promise<void> {
  if (!openDraftRow.value) return
  await ElMessageBox.confirm('放弃当前复勘草稿？草稿中的修改将不会进入任何封存版本。', '放弃草稿', {
    type: 'warning',
    confirmButtonText: '放弃草稿'
  })
  await discardDraft(openDraftRow.value.id)
  await archiveStore.getState().hydrate()
  emitArchiveEvent('draft-discarded', { trenchId: props.trenchId })
  ElMessage.success('复勘草稿已放弃，探方恢复只读')
}

function filePrefix(version: ArchiveVersion): string {
  return `${props.trenchLabel.replace(/[\s·]+/g, '_')}_封存v${version.versionNo}`
}

function exportJson(version: ArchiveVersion, bundle: VersionBundle): void {
  downloadJson(`${filePrefix(version)}.json`, { ...bundle, exportedAt: new Date().toISOString() })
  ElMessage.success(`封存 v${version.versionNo} JSON 已导出`)
}

function exportStrataCsv(version: ArchiveVersion, bundle: VersionBundle): void {
  downloadCsv(
    `${filePrefix(version)}_地层单位.csv`,
    bundle.strata.map((item) => ({ ...item, inclusions: item.inclusions.join('、') })) as unknown as Record<
      string,
      unknown
    >[],
    [
      { key: 'code', label: '单位号' },
      { key: 'type', label: '类型' },
      { key: 'openLayer', label: '开口层位' },
      { key: 'topDepth', label: '上界深度' },
      { key: 'bottomDepth', label: '下界深度' },
      { key: 'soil', label: '土质土色' },
      { key: 'inclusions', label: '包含物' },
      { key: 'formation', label: '堆积成因' },
      { key: 'drawingNo', label: '绘图拍照号' }
    ]
  )
  ElMessage.success('地层单位 CSV 已导出')
}

function exportArtifactsCsv(version: ArchiveVersion, bundle: VersionBundle): void {
  const unitName = new Map(bundle.strata.map((item) => [item.id, item.code]))
  downloadCsv(
    `${filePrefix(version)}_出土物.csv`,
    bundle.artifacts.map((item) => ({ ...item, stratum: unitName.get(item.stratumId) ?? item.stratumId })) as unknown as Record<
      string,
      unknown
    >[],
    [
      { key: 'code', label: '器物编号' },
      { key: 'stratum', label: '地层单位' },
      { key: 'category', label: '类别' },
      { key: 'count', label: '件数' },
      { key: 'completeness', label: '残整程度' },
      { key: 'x', label: 'X(m)' },
      { key: 'y', label: 'Y(m)' },
      { key: 'z', label: 'Z深度(m)' },
      { key: 'date', label: '出土日期' },
      { key: 'collector', label: '提取人' },
      { key: 'tempLocation', label: '临时存放' }
    ]
  )
  ElMessage.success('出土物 CSV 已导出')
}

function exportRelationsCsv(version: ArchiveVersion, bundle: VersionBundle): void {
  const unitName = new Map(bundle.strata.map((item) => [item.id, item.code]))
  const name = (id: string): string => unitName.get(id) ?? id
  downloadCsv(
    `${filePrefix(version)}_层位关系.csv`,
    bundle.relations.map((item) => ({ ...item, unitA: name(item.unitAId), unitB: name(item.unitBId) })) as unknown as Record<
      string,
      unknown
    >[],
    [
      { key: 'unitA', label: '单位A' },
      { key: 'type', label: '关系' },
      { key: 'unitB', label: '单位B' },
      { key: 'basis', label: '判定依据' },
      { key: 'recorder', label: '记录人' },
      { key: 'note', label: '备注' }
    ]
  )
  ElMessage.success('层位关系 CSV 已导出')
}

function unitText(id: string, bundle: VersionBundle): string {
  return bundle.strata.find((item) => item.id === id)?.code ?? id
}
</script>

<template>
  <el-drawer v-model="visible" :title="`封存版本 · ${trenchLabel}`" size="62%" direction="rtl">
    <div v-if="openDraftRow" class="draft-tip">
      <el-alert type="warning" :closable="false" show-icon>
        <template #title>
          存在进行中的复勘草稿（基于 v{{ openDraftRow.baseVersionNo }}，开启于
          {{ openDraftRow.createdAt.slice(0, 16).replace('T', ' ') }}）
        </template>
        <template #default>
          各编目页当前编辑的是该草稿；提交后生成新版本，封存版保持不变。
          <el-button size="small" type="danger" plain style="margin-left: 10px" @click="abandonDraft">放弃草稿</el-button>
        </template>
      </el-alert>
    </div>

    <el-table :data="versions" v-loading="loading" border stripe size="small" class="version-table">
      <el-table-column label="版本" width="70">
        <template #default="{ row }: { row: ArchiveVersion }">
          <el-tag :type="row.versionNo === versions[0]?.versionNo ? 'success' : 'info'" size="small" effect="plain">
            v{{ row.versionNo }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="封存说明" min-width="180" show-overflow-tooltip />
      <el-table-column label="封存时间" width="160">
        <template #default="{ row }: { row: ArchiveVersion }">{{ row.createdAt.slice(0, 16).replace('T', ' ') }}</template>
      </el-table-column>
      <el-table-column label="基底" width="80">
        <template #default="{ row }: { row: ArchiveVersion }">{{ row.parentId ? `v${row.versionNo - 1}` : '首版' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }: { row: ArchiveVersion }">
          <el-button link type="primary" size="small" @click="view(row)">查看/导出</el-button>
          <el-button
            link
            type="warning"
            size="small"
            :disabled="Boolean(openDraftRow)"
            @click="startDraft(row)"
          >
            开复勘草稿
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <template v-if="viewing">
      <el-divider content-position="left">
        v{{ viewing.version.versionNo }} 冻结内容（{{ viewing.strata.length }} 单位 ·
        {{ viewing.artifacts.length }} 出土物 · {{ viewing.relations.length }} 关系）
      </el-divider>

      <div class="export-bar">
        <el-button size="small" @click="exportJson(viewing.version, viewing)">导出整版 JSON</el-button>
        <el-button size="small" @click="exportStrataCsv(viewing.version, viewing)">地层单位 CSV</el-button>
        <el-button size="small" @click="exportArtifactsCsv(viewing.version, viewing)">出土物 CSV</el-button>
        <el-button size="small" @click="exportRelationsCsv(viewing.version, viewing)">层位关系 CSV</el-button>
      </div>

      <el-descriptions :column="2" size="small" border class="snap-desc">
        <el-descriptions-item label="探方">{{ viewing.trench.area }} · {{ viewing.trench.code }}</el-descriptions-item>
        <el-descriptions-item label="规格">{{ viewing.trench.size }}</el-descriptions-item>
        <el-descriptions-item label="基点坐标">{{ viewing.trench.basePoint || '—' }}</el-descriptions-item>
        <el-descriptions-item label="开口层位">{{ viewing.trench.openLayer || '—' }}</el-descriptions-item>
        <el-descriptions-item label="发掘日期">{{ viewing.trench.startDate }} ~ {{ viewing.trench.endDate || '进行中' }}</el-descriptions-item>
        <el-descriptions-item label="负责人">{{ viewing.trench.leader || '—' }}</el-descriptions-item>
      </el-descriptions>

      <h4 class="snap-title">地层单位</h4>
      <el-table :data="viewing.strata" border size="small" class="snap-table">
        <el-table-column prop="code" label="单位号" width="90" />
        <el-table-column prop="type" label="类型" width="80" />
        <el-table-column prop="openLayer" label="开口层位" width="100" />
        <el-table-column label="深度(m)" width="130">
          <template #default="{ row }: { row: Stratum }">
            {{ row.topDepth }} – {{ row.bottomDepth }}
          </template>
        </el-table-column>
        <el-table-column prop="soil" label="土质土色" min-width="140" show-overflow-tooltip />
        <el-table-column label="包含物" width="130">
          <template #default="{ row }: { row: Stratum }">{{ row.inclusions.join('、') || '—' }}</template>
        </el-table-column>
      </el-table>

      <h4 class="snap-title">出土物（{{ viewing.artifacts.length }}）</h4>
      <el-table :data="viewing.artifacts" border size="small" class="snap-table">
        <el-table-column prop="code" label="器物编号" width="130" />
        <el-table-column prop="category" label="类别" width="80" />
        <el-table-column prop="count" label="件数" width="60" />
        <el-table-column prop="completeness" label="残整" width="80" />
        <el-table-column label="Z 深度" width="90">
          <template #default="{ row }: { row: Artifact }">{{ row.z }} m</template>
        </el-table-column>
        <el-table-column prop="collector" label="提取人" width="80" />
        <el-table-column prop="tempLocation" label="临时存放" min-width="120" show-overflow-tooltip />
      </el-table>

      <h4 class="snap-title">层位关系（{{ viewing.relations.length }}）</h4>
      <ul class="snap-relations">
        <li v-for="row in viewing.relations" :key="row.id">
          {{ unitText(row.unitAId, viewing) }}
          <el-tag size="small" effect="dark" class="rel-type">{{ row.type }}</el-tag>
          {{ unitText(row.unitBId, viewing) }}
          <span class="muted">（{{ row.basis }} · {{ row.recorder || '未填记录人' }}）</span>
        </li>
        <li v-if="viewing.relations.length === 0" class="muted">无层位关系</li>
      </ul>
    </template>
  </el-drawer>
</template>

<style scoped>
.draft-tip {
  margin-bottom: 12px;
}
.version-table {
  margin-bottom: 8px;
}
.export-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 12px;
}
.snap-desc {
  margin-bottom: 10px;
}
.snap-title {
  margin: 14px 0 6px;
  font-size: 13px;
}
.snap-table {
  margin-bottom: 4px;
}
.snap-relations {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.snap-relations li {
  padding: 5px 0;
  border-bottom: 1px dotted #e6ded0;
}
.rel-type {
  margin: 0 6px;
}
.muted {
  color: #8a8073;
}
</style>
