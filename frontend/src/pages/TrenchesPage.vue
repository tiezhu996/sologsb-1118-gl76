<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { SurveyDraft, Trench } from '@/types'
import { TRENCH_SIZES, findTrenchConflict, trenchKey } from '@/types'
import TrenchTag from '@/components/common/TrenchTag.vue'
import DraftBanner from '@/components/archive/DraftBanner.vue'
import CommitDraftDialog from '@/components/archive/CommitDraftDialog.vue'
import ArchiveDrawer from '@/components/archive/ArchiveDrawer.vue'
import { useCatalog } from '@/hooks/useCatalog'
import { sealTrench } from '@/services/archiveService'
import { archiveStore } from '@/stores/archiveStore'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { discardDraft } from '@/services/archiveService'
import { ReadonlyArchiveError } from '@/hooks/useCatalog'
import { emitArchiveEvent } from '@/hooks/useArchiveEvents'
import { uid } from '@/utils/id'

const router = useRouter()
const catalog = useCatalog()
const archiveState = useStore(archiveStore)

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const filterArea = ref('')

const drawerVisible = ref(false)
const drawerTrenchId = ref('')
const drawerTrenchLabel = ref('')

const commitVisible = ref(false)
const commitDraftRow = ref<SurveyDraft | null>(null)

const form = reactive({
  code: '',
  area: '',
  size: '5×5 米' as Trench['size'],
  basePoint: '',
  openLayer: '第①层',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  leader: '',
  wallNote: '',
  backfilled: false
})

const areas = computed(() => Array.from(new Set(catalog.trenches.value.map((item) => item.area))))
const visible = computed(() =>
  filterArea.value ? catalog.trenches.value.filter((item) => item.area === filterArea.value) : catalog.trenches.value
)

watch(
  () => catalog.trenches.value.length,
  () => {
    if (!form.area && catalog.trenches.value.length > 0) {
      form.area = catalog.trenches.value[0].area
    }
  },
  { immediate: true }
)

/** 单位数与出土物件数（走门面合并视图） */
function unitsOf(trenchId: string): number {
  return catalog.strata.value.filter((item) => item.trenchId === trenchId).length
}

function artifactsOf(trenchId: string): number {
  const unitIds = catalog.strata.value.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return catalog.artifacts.value
    .filter((item) => unitIds.includes(item.stratumId))
    .reduce((sum, item) => sum + item.count, 0)
}

function relationsOf(trenchId: string): number {
  const unitIds = catalog.strata.value.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return catalog.relations.value.filter((item) => unitIds.includes(item.unitAId) || unitIds.includes(item.unitBId)).length
}

function latestVersionNo(trenchId: string): number | null {
  return archiveState.versions
    .filter((item) => item.trenchId === trenchId)
    .sort((a, b) => b.versionNo - a.versionNo)[0]?.versionNo ?? null
}

/** 发掘进度状态 */
function progressOf(trench: Trench): { label: string; type: 'success' | 'warning' | 'info' } {
  if (trench.backfilled) return { label: '已回填封存', type: 'info' }
  if (unitsOf(trench.id) === 0) return { label: '待发掘', type: 'warning' }
  if (trench.endDate) return { label: '发掘完成', type: 'success' }
  return { label: '发掘中', type: 'success' }
}

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.area = catalog.trenches.value[0]?.area ?? ''
  form.size = '5×5 米'
  form.basePoint = ''
  form.openLayer = '第①层'
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = ''
  form.leader = ''
  form.wallNote = ''
  form.backfilled = false
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(trench: Trench): void {
  if (catalog.isReadonly(trench.id)) {
    ElMessage.info('该探方已回填封存，页面为只读；点击「封存版本」可查看旧版或开启复勘草稿')
    openVersions(trench)
    return
  }
  editingId.value = trench.id
  Object.assign(form, {
    code: trench.code,
    area: trench.area,
    size: trench.size,
    basePoint: trench.basePoint,
    openLayer: trench.openLayer,
    startDate: trench.startDate,
    endDate: trench.endDate,
    leader: trench.leader,
    wallNote: trench.wallNote,
    backfilled: trench.backfilled
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.code.trim() || !form.area.trim()) {
    ElMessage.warning('探方号与发掘区必填')
    return
  }
  const candidate = { id: editingId.value ?? uid('tr'), area: form.area.trim(), code: form.code.trim().toUpperCase() }
  const conflict = findTrenchConflict(catalog.trenches.value, candidate)
  if (conflict) {
    ElMessage.error(`「${trenchKey(candidate)}」已存在（同发掘区探方号必须唯一）`)
    return
  }
  // 封存体系下回填只能通过「回填确认封存」完成，普通编辑不允许直接把探方改成已回填
  if (form.backfilled && !editingId.value) {
    ElMessage.warning('新建探方不能直接回填；发掘结束后请用「回填确认封存」生成封存版本')
    return
  }
  const row: Trench = {
    id: candidate.id,
    code: candidate.code,
    area: candidate.area,
    size: form.size,
    basePoint: form.basePoint.trim(),
    openLayer: form.openLayer.trim(),
    startDate: form.startDate,
    endDate: form.endDate,
    leader: form.leader.trim(),
    wallNote: form.wallNote.trim(),
    backfilled: form.backfilled
  }
  try {
    await catalog.saveTrench(row)
    ElMessage.success(`探方 ${trenchKey(row)} 已保存`)
    dialogVisible.value = false
  } catch (error) {
    if (error instanceof ReadonlyArchiveError) ElMessage.error(error.message)
    else throw error
  }
}

async function confirmSeal(trench: Trench): Promise<void> {
  const units = unitsOf(trench.id)
  await ElMessageBox.confirm(
    `确认「${trenchKey(trench)}」回填封存？将冻结探方${units > 0 ? `、${units} 个地层单位` : ''}、出土物与层位关系，生成第一版封存；封存后页面默认只读。`,
    '回填确认封存',
    { type: 'warning', confirmButtonText: '确认回填并封存' }
  )
  const version = await sealTrench(trench)
  await Promise.all([trenchStore.getState().hydrate(), archiveStore.getState().hydrate()])
  emitArchiveEvent('sealed', { trenchId: trench.id, version })
  ElMessage.success(`已生成封存 v${version.versionNo}：${trenchKey(trench)} 现已只读，修改请开复勘草稿`)
}

function openVersions(trench: Trench): void {
  drawerTrenchId.value = trench.id
  drawerTrenchLabel.value = trenchKey(trench)
  drawerVisible.value = true
}

async function remove(trench: Trench): Promise<void> {
  if (catalog.isSealed(trench.id)) {
    ElMessage.error('已封存探方不可删除（封存版本是回填档案，只可查看/导出/复勘）')
    return
  }
  const units = unitsOf(trench.id)
  if (units > 0) {
    ElMessage.error(`${trenchKey(trench)} 下仍有 ${units} 个地层单位，请先清理下级记录`)
    return
  }
  await ElMessageBox.confirm(`确认删除探方「${trenchKey(trench)}」？`, '删除确认', { type: 'warning' })
  await trenchStore.getState().remove(trench.id)
  ElMessage.success('探方已删除')
}

function openCommit(draft: SurveyDraft): void {
  commitDraftRow.value = draft
  commitVisible.value = true
}

function syncDraftAfterRebase(draftId: string): void {
  // rebase 后草稿基底已变，同步当前引用；无冲突时对话框保持打开可直接重交
  commitDraftRow.value = archiveState.drafts.find((item) => item.id === draftId && item.status === 'open') ?? null
}

async function abandonDraft(draft: SurveyDraft): Promise<void> {
  await ElMessageBox.confirm('放弃该复勘草稿？草稿中的修改不会进入任何封存版本。', '放弃草稿', {
    type: 'warning',
    confirmButtonText: '放弃草稿'
  })
  await discardDraft(draft.id)
  await archiveStore.getState().hydrate()
  emitArchiveEvent('draft-discarded', { trenchId: draft.trenchId })
  ElMessage.success('草稿已放弃')
}

function goEdit(): void {
  router.push('/strata')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">探方清单</h2>
        <p class="page-sub">
          回填确认即生成封存版本（冻结探方、地层单位、出土物、层位关系），封存后页面只读；修改请从封存版开复勘草稿。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建探方
      </el-button>
    </div>

    <DraftBanner @submit="openCommit" @discard="abandonDraft" />

    <div class="toolbar">
      <el-select v-model="filterArea" placeholder="全部发掘区" clearable style="width: 180px">
        <el-option v-for="area in areas" :key="area" :label="area" :value="area" />
      </el-select>
      <el-tag effect="plain">命中 {{ visible.length }} / {{ catalog.trenches.value.length }} 个探方</el-tag>
    </div>

    <div class="card-grid">
      <el-card v-for="trench in visible" :key="trench.id" shadow="hover" class="trench-card">
        <div class="card-top">
          <TrenchTag :trench="trench" />
          <el-tag :type="progressOf(trench).type" size="small" effect="plain">{{ progressOf(trench).label }}</el-tag>
        </div>
        <div v-if="latestVersionNo(trench.id) !== null" class="sealed-line">
          <el-tag type="success" size="small" effect="dark">封存 v{{ latestVersionNo(trench.id) }}</el-tag>
          <span v-if="catalog.draftOf(trench.id)" class="draft-note">复勘草稿进行中</span>
        </div>
        <div class="metrics">
          <div class="metric"><span>地层单位</span><b>{{ unitsOf(trench.id) }}</b></div>
          <div class="metric"><span>出土物件数</span><b>{{ artifactsOf(trench.id) }}</b></div>
          <div class="metric"><span>层位关系</span><b>{{ relationsOf(trench.id) }}</b></div>
          <div class="metric"><span>规格</span><b>{{ trench.size }}</b></div>
        </div>
        <el-descriptions :column="1" size="small" border class="desc">
          <el-descriptions-item label="基点坐标">{{ trench.basePoint || '—' }}</el-descriptions-item>
          <el-descriptions-item label="开口层位">{{ trench.openLayer || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发掘日期">
            {{ trench.startDate }} ~ {{ trench.endDate || '进行中' }}
          </el-descriptions-item>
          <el-descriptions-item label="负责人">{{ trench.leader || '—' }}</el-descriptions-item>
          <el-descriptions-item label="四壁方向备注">{{ trench.wallNote || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="card-actions">
          <el-button size="small" @click="openEdit(trench)">
            {{ catalog.isReadonly(trench.id) ? '查看' : '编辑' }}
          </el-button>
          <el-button
            v-if="!trench.backfilled && !catalog.draftOf(trench.id)"
            size="small"
            type="warning"
            plain
            @click="confirmSeal(trench)"
          >
            回填确认封存
          </el-button>
          <el-button v-if="catalog.isSealed(trench.id)" size="small" type="success" plain @click="openVersions(trench)">
            封存版本<template v-if="latestVersionNo(trench.id)"> v{{ latestVersionNo(trench.id) }}</template>
          </el-button>
          <el-button
            v-if="catalog.draftOf(trench.id)"
            size="small"
            type="primary"
            plain
            @click="goEdit"
          >
            去复勘编辑
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(trench)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="visible.length === 0" description="暂无探方，先新建一个探方" />
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑探方' : '新建探方'" width="640px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘区" required>
              <el-input v-model="form.area" placeholder="如 Ⅱ区" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="探方号" required>
              <el-input v-model="form.code" placeholder="如 T0501" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="规格">
              <el-select v-model="form.size" style="width: 100%">
                <el-option v-for="item in TRENCH_SIZES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基点坐标">
              <el-input v-model="form.basePoint" placeholder="如 N1200 / E3000" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="开口层位">
              <el-input v-model="form.openLayer" placeholder="如 第①层" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责人">
              <el-input v-model="form.leader" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘起始">
              <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="发掘结束">
              <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="四壁备注">
          <el-input v-model="form.wallNote" type="textarea" :rows="2" placeholder="如 北壁、东壁保存较好；南壁被现代扰坑破坏" />
        </el-form-item>
        <el-alert
          v-if="editingId && catalog.draftOf(editingId)"
          type="warning"
          :closable="false"
          title="当前编辑写入复勘草稿，提交草稿后才会生成新封存版本"
          style="margin-top: 6px"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <ArchiveDrawer v-model="drawerVisible" :trench-id="drawerTrenchId" :trench-label="drawerTrenchLabel" />
    <CommitDraftDialog v-model="commitVisible" :draft="commitDraftRow" @draft-rebased="syncDraftAfterRebase" />
  </div>
</template>

<style scoped>
.trench-card {
  border-radius: 12px;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.sealed-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.draft-note {
  font-size: 12px;
  color: #a9762f;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f7f4ee;
  font-size: 12px;
  color: #7d7264;
}
.metric b {
  font-size: 14px;
  color: #3c2f1f;
}
.desc {
  margin-bottom: 12px;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
