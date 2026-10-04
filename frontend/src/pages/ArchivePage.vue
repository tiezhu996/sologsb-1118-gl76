<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { SealedVersion } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { sealStore } from '@/stores/sealStore'
import { exportVersionCsv, exportVersionJson } from '@/utils/archiveExport'

const route = useRoute()
const router = useRouter()
const trenchState = useStore(trenchStore)
const sealState = useStore(sealStore)

const selectedTrenchId = ref(typeof route.query.trench === 'string' ? route.query.trench : '')
const selectedVersionId = ref(typeof route.query.version === 'string' ? route.query.version : '')

const trenchesWithSeal = computed(() =>
  trenchState.trenches.filter((trench) => sealState.versions.some((version) => version.trenchId === trench.id))
)

watch(
  trenchesWithSeal,
  (list) => {
    if ((!selectedTrenchId.value || !list.some((item) => item.id === selectedTrenchId.value)) && list.length > 0) {
      selectedTrenchId.value = list[0].id
    }
  },
  { immediate: true }
)

const versions = computed(() => sealState.versionsOf(selectedTrenchId.value))

watch(
  versions,
  (list) => {
    if (list.length === 0) {
      selectedVersionId.value = ''
      return
    }
    if (!list.some((item) => item.id === selectedVersionId.value)) {
      selectedVersionId.value = list[0].id
    }
  },
  { immediate: true }
)

const selectedVersion = computed<SealedVersion | null>(
  () => versions.value.find((item) => item.id === selectedVersionId.value) ?? null
)

const selectedTrench = computed(() => trenchState.trenches.find((item) => item.id === selectedTrenchId.value) ?? null)
const draftOfSelected = computed(() => sealState.draftOf(selectedTrenchId.value))

watch(selectedTrenchId, (id) => {
  router.replace({ query: { ...route.query, trench: id || undefined, version: undefined } })
})
watch(selectedVersionId, (id) => {
  if (id) router.replace({ query: { ...route.query, version: id } })
})

function exportJson(): void {
  if (!selectedVersion.value) return
  exportVersionJson(selectedVersion.value)
  ElMessage.success('封存版本 JSON 已导出')
}

function exportCsv(): void {
  if (!selectedVersion.value) return
  exportVersionCsv(selectedVersion.value)
  ElMessage.success('封存版本 CSV 已导出（地层单位 / 出土物 / 层位关系）')
}

function goRework(): void {
  const draft = draftOfSelected.value
  if (draft) {
    router.push({ path: '/rework', query: { draft: draft.id } })
  } else {
    router.push({ path: '/trenches' })
  }
}
</script>

<template>
  <div class="page archive-page">
    <div class="page-head">
      <div>
        <h2 class="page-title">封存版本档案</h2>
        <p class="page-sub">
          回填确认后每一次复勘提交都会生成新封存版本；旧版始终可查看与导出，不会因后续改正而变动。选择探方与版本核对封存时的探方、地层单位、出土物与层位关系。
        </p>
      </div>
      <div class="head-actions">
        <el-select v-model="selectedTrenchId" placeholder="选择已封存探方" style="width: 220px">
          <el-option
            v-for="trench in trenchesWithSeal"
            :key="trench.id"
            :label="`${trench.area} · ${trench.code}（${sealState.versionsOf(trench.id).length} 版）`"
            :value="trench.id"
          />
        </el-select>
        <el-button :disabled="!selectedVersion" @click="exportJson">导出 JSON</el-button>
        <el-button type="primary" plain :disabled="!selectedVersion" @click="exportCsv">导出 CSV</el-button>
      </div>
    </div>

    <el-empty v-if="trenchesWithSeal.length === 0" description="暂无封存版本：回填确认后会自动封存第一版" />

    <div v-else-if="selectedVersion" class="layout">
      <el-card shadow="never" class="timeline-card">
        <template #header>版本时间线（{{ versions.length }}）</template>
        <el-timeline>
          <el-timeline-item
            v-for="version in versions"
            :key="version.id"
            :type="version.id === selectedVersionId ? 'primary' : 'info'"
            :hollow="version.id !== selectedVersionId"
            :timestamp="`${version.sealedAt.slice(0, 16).replace('T', ' ')} · ${version.sealedBy}`"
            placement="top"
          >
            <el-button
              link
              :type="version.id === selectedVersionId ? 'primary' : 'default'"
              :class="{ active: version.id === selectedVersionId }"
              @click="selectedVersionId = version.id"
            >
              第 {{ version.versionNo }} 版{{ version.versionNo === versions[0]?.versionNo ? '（最新）' : '' }}
            </el-button>
            <p class="note">{{ version.note }}</p>
          </el-timeline-item>
        </el-timeline>
        <el-alert
          v-if="draftOfSelected"
          type="warning"
          :closable="false"
          show-icon
          class="draft-tip"
          :title="`该探方有复勘草稿进行中（基于第 ${draftOfSelected.baseVersionNo} 版）`"
        >
          <el-button size="small" type="primary" plain @click="goRework">前往复勘工作台</el-button>
        </el-alert>
      </el-card>

      <el-card shadow="never" class="detail-card">
        <template #header>
          <div class="detail-head">
            <span>
              {{ selectedTrench?.area }} · {{ selectedTrench?.code }} · 第 {{ selectedVersion.versionNo }} 版封存内容
            </span>
            <el-tag size="small" type="info" effect="plain">
              {{ selectedVersion.snapshot.strata.length }} 单位 · {{ selectedVersion.snapshot.artifacts.length }} 出土物 ·
              {{ selectedVersion.snapshot.relations.length }} 关系
            </el-tag>
          </div>
        </template>

        <el-descriptions :column="2" size="small" border class="desc">
          <el-descriptions-item label="规格">{{ selectedVersion.snapshot.trench.size }}</el-descriptions-item>
          <el-descriptions-item label="基点坐标">{{ selectedVersion.snapshot.trench.basePoint || '—' }}</el-descriptions-item>
          <el-descriptions-item label="开口层位">{{ selectedVersion.snapshot.trench.openLayer || '—' }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ selectedVersion.snapshot.trench.leader || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发掘日期">
            {{ selectedVersion.snapshot.trench.startDate }} ~ {{ selectedVersion.snapshot.trench.endDate || '进行中' }}
          </el-descriptions-item>
          <el-descriptions-item label="封存说明">{{ selectedVersion.note }}</el-descriptions-item>
          <el-descriptions-item label="四壁备注" :span="2">{{ selectedVersion.snapshot.trench.wallNote || '—' }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="sub-title">地层单位（{{ selectedVersion.snapshot.strata.length }}）</h4>
        <el-table :data="selectedVersion.snapshot.strata" size="small" border>
          <el-table-column prop="code" label="单位号" width="90" />
          <el-table-column prop="type" label="类型" width="80" />
          <el-table-column prop="openLayer" label="开口层位" width="100" />
          <el-table-column label="深度(m)" width="110">
            <template #default="{ row }">{{ row.topDepth }}–{{ row.bottomDepth }}</template>
          </el-table-column>
          <el-table-column prop="soil" label="土质土色" min-width="140" show-overflow-tooltip />
          <el-table-column label="包含物" width="140">
            <template #default="{ row }">{{ row.inclusions.join('、') || '—' }}</template>
          </el-table-column>
        </el-table>

        <h4 class="sub-title">出土物（{{ selectedVersion.snapshot.artifacts.length }}）</h4>
        <el-table :data="selectedVersion.snapshot.artifacts" size="small" border>
          <el-table-column prop="code" label="器物编号" width="140" />
          <el-table-column label="所属单位" width="100">
            <template #default="{ row }">
              {{ selectedVersion.snapshot.strata.find((s) => s.id === row.stratumId)?.code ?? row.stratumId }}
            </template>
          </el-table-column>
          <el-table-column prop="category" label="类别" width="80" />
          <el-table-column prop="count" label="件数" width="70" />
          <el-table-column label="坐标 X,Y,Z" width="160">
            <template #default="{ row }">{{ row.x }}, {{ row.y }}, {{ row.z }}</template>
          </el-table-column>
          <el-table-column prop="collector" label="提取人" width="90" />
        </el-table>

        <h4 class="sub-title">层位关系（{{ selectedVersion.snapshot.relations.length }}）</h4>
        <ul v-if="selectedVersion.snapshot.relations.length > 0" class="rel-list">
          <li v-for="relation in selectedVersion.snapshot.relations" :key="relation.id">
            <span class="mono">{{ selectedVersion.snapshot.strata.find((s) => s.id === relation.unitAId)?.code ?? relation.unitAId }}</span>
            <el-tag size="small" effect="dark" class="type">{{ relation.type }}</el-tag>
            <span class="mono">{{ selectedVersion.snapshot.strata.find((s) => s.id === relation.unitBId)?.code ?? relation.unitBId }}</span>
            <span class="muted">（{{ relation.basis }} · {{ relation.recorder || '未填记录人' }}）{{ relation.note }}</span>
          </li>
        </ul>
        <p v-else class="muted">本版暂无层位关系记录</p>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.layout {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.timeline-card {
  width: 300px;
  border-radius: 12px;
}
.detail-card {
  flex: 1 1 520px;
  border-radius: 12px;
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.active {
  font-weight: 700;
}
.note {
  margin: 2px 0 0;
  font-size: 12px;
  color: #8a8073;
}
.draft-tip {
  margin-top: 10px;
}
.sub-title {
  margin: 16px 0 8px;
  font-size: 13px;
}
.muted {
  color: #8a8073;
  font-size: 12px;
}
.rel-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.rel-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px dotted #e6ded0;
}
.type {
  margin: 0 2px;
}
</style>
