<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Trench } from '@/types'
import { findTrenchConflict, trenchKey } from '@/types'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { sealStore } from '@/stores/sealStore'
import { isTrenchFrozenError } from '@/utils/errors'
import { uid } from '@/utils/id'

const router = useRouter()
const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)
const sealState = useStore(sealStore)

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const filterArea = ref('')

/** 回填确认封存弹窗 */
const sealDialogVisible = ref(false)
const sealingTrench = ref<Trench | null>(null)
const sealForm = reactive({ sealedBy: '', note: '回填确认封存' })

const form = reactive({
  code: '',
  area: '',
  size: '5×5 米' as Trench['size'],
  basePoint: '',
  openLayer: '第①层',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  leader: '',
  wallNote: ''
})

const areas = computed(() => Array.from(new Set(trenchState.trenches.map((item) => item.area))))
const visible = computed(() =>
  filterArea.value ? trenchState.trenches.filter((item) => item.area === filterArea.value) : trenchState.trenches
)

watch(
  () => trenchState.trenches.length,
  () => {
    if (!form.area && trenchState.trenches.length > 0) {
      form.area = trenchState.trenches[0].area
    }
  },
  { immediate: true }
)

/** 单位数与出土物件数 */
function unitsOf(trenchId: string): number {
  return stratumState.strata.filter((item) => item.trenchId === trenchId).length
}

function artifactsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return artifactState.artifacts.filter((item) => unitIds.includes(item.stratumId)).reduce((sum, item) => sum + item.count, 0)
}

function relationsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return relationState.relations.filter((item) => unitIds.includes(item.unitAId) || unitIds.includes(item.unitBId)).length
}

function latestVersionOf(trenchId: string) {
  return sealState.latestVersionOf(trenchId)
}

function draftOf(trenchId: string) {
  return sealState.draftOf(trenchId)
}

/** 发掘进度状态 */
function progressOf(trench: Trench): { label: string; type: 'success' | 'warning' | 'info' } {
  if (sealState.isSealed(trench.id)) return { label: `已封存 v${latestVersionOf(trench.id)?.versionNo ?? 1}`, type: 'info' }
  if (unitsOf(trench.id) === 0) return { label: '待发掘', type: 'warning' }
  if (trench.endDate) return { label: '发掘完成', type: 'success' }
  return { label: '发掘中', type: 'success' }
}

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.area = trenchState.trenches[0]?.area ?? ''
  form.size = '5×5 米'
  form.basePoint = ''
  form.openLayer = '第①层'
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = ''
  form.leader = ''
  form.wallNote = ''
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(trench: Trench): void {
  if (sealState.isSealed(trench.id)) {
    ElMessage.info('该探方已封存为只读，点击「复勘修正」从封存版开启草稿')
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
    wallNote: trench.wallNote
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.code.trim() || !form.area.trim()) {
    ElMessage.warning('探方号与发掘区必填')
    return
  }
  const candidate = { id: editingId.value ?? uid('tr'), area: form.area.trim(), code: form.code.trim().toUpperCase() }
  const conflict = findTrenchConflict(trenchState.trenches, candidate)
  if (conflict) {
    ElMessage.error(`「${trenchKey(candidate)}」已存在（同发掘区探方号必须唯一）`)
    return
  }
  const existing = editingId.value ? trenchState.trenches.find((item) => item.id === editingId.value) : null
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
    backfilled: existing?.backfilled ?? false
  }
  try {
    await trenchStore.getState().save(row)
    ElMessage.success(`探方 ${trenchKey(row)} 已保存`)
    dialogVisible.value = false
  } catch (error) {
    if (isTrenchFrozenError(error)) ElMessage.error(error.message)
    else throw error
  }
}

async function remove(trench: Trench): Promise<void> {
  const units = unitsOf(trench.id)
  if (units > 0) {
    ElMessage.error(`${trenchKey(trench)} 下仍有 ${units} 个地层单位，请先清理下级记录`)
    return
  }
  await ElMessageBox.confirm(`确认删除探方「${trenchKey(trench)}」？`, '删除确认', { type: 'warning' })
  try {
    await trenchStore.getState().remove(trench.id)
    ElMessage.success('探方已删除')
  } catch (error) {
    if (isTrenchFrozenError(error)) {
      ElMessage.error('该探方已有封存版本，不允许删除；如需修正请走复勘草稿')
    } else {
      throw error
    }
  }
}

/* ------------------------------- 回填确认封存 ------------------------------- */

function openSealDialog(trench: Trench): void {
  sealingTrench.value = trench
  sealForm.sealedBy = trench.leader || ''
  sealForm.note = '回填确认封存'
  sealDialogVisible.value = true
}

async function confirmSeal(): Promise<void> {
  if (!sealingTrench.value) return
  await ElMessageBox.confirm(
    `回填确认后将冻结「${trenchKey(sealingTrench.value)}」的探方、地层单位、出土物与层位关系，页面默认只读。确认封存第一版？`,
    '回填确认封存',
    { type: 'warning', confirmButtonText: '确认封存', cancelButtonText: '再核一下' }
  )
  try {
    const version = await sealStore.getState().sealTrench({
      trenchId: sealingTrench.value.id,
      sealedBy: sealForm.sealedBy,
      note: sealForm.note
    })
    ElMessage.success(`已封存为第 ${version.versionNo} 版，后续修改需开启复勘草稿`)
    sealDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '封存失败，请重试')
  }
}

/* --------------------------------- 复勘入口 -------------------------------- */

async function startRework(trench: Trench): Promise<void> {
  const draft = sealState.draftOf(trench.id)
  if (draft) {
    router.push({ path: '/rework', query: { draft: draft.id } })
    return
  }
  let reason: string | null = null
  try {
    const result = await ElMessageBox.prompt(
      `将从「${trenchKey(trench)}」第 ${latestVersionOf(trench.id)?.versionNo ?? 1} 版封存快照开启复勘草稿，实时档案保持只读。请填写复勘事由：`,
      '开启复勘草稿',
      {
        confirmButtonText: '开启草稿',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputValue: '回填后复勘修正',
        inputPlaceholder: '如 回填后核对发现 H12 下界深度与编号需修正'
      }
    )
    reason = result.value
  } catch {
    return
  }
  const created = await sealStore.getState().openDraft({ trenchId: trench.id, createdBy: trench.leader, reason })
  ElMessage.success('复勘草稿已开启，可在工作台修改并提交生成新版本')
  router.push({ path: '/rework', query: { draft: created.id } })
}

function viewArchive(trench: Trench): void {
  router.push({ path: '/archive', query: { trench: trench.id } })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">探方清单</h2>
        <p class="page-sub">
          按「发掘区-探方号」校验唯一性；卡片展示地层单位数、出土物件数、层位关系数与发掘进度状态。回填确认即封存第一版，封存后默认只读。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建探方
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="filterArea" placeholder="全部发掘区" clearable style="width: 180px">
        <el-option v-for="area in areas" :key="area" :label="area" :value="area" />
      </el-select>
      <el-tag effect="plain">命中 {{ visible.length }} / {{ trenchState.trenches.length }} 个探方</el-tag>
    </div>

    <div class="card-grid">
      <el-card v-for="trench in visible" :key="trench.id" shadow="hover" class="trench-card" :class="{ sealed: sealState.isSealed(trench.id) }">
        <div class="card-top">
          <TrenchTag :trench="trench" />
          <el-tag :type="progressOf(trench).type" size="small" effect="plain">{{ progressOf(trench).label }}</el-tag>
        </div>
        <div v-if="sealState.isSealed(trench.id)" class="seal-banner">
          <el-icon><Lock /></el-icon>
          <span>
            封存只读 · 第 {{ latestVersionOf(trench.id)?.versionNo }} 版（{{ (latestVersionOf(trench.id)?.sealedAt ?? '').slice(0, 10) }}
            封存）
          </span>
        </div>
        <div v-if="draftOf(trench.id)" class="draft-banner">
          <el-icon><EditPen /></el-icon>
          <span>复勘草稿进行中（基于第 {{ draftOf(trench.id)?.baseVersionNo }} 版）</span>
          <el-button link type="primary" size="small" @click="startRework(trench)">前往工作台</el-button>
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
          <template v-if="!sealState.isSealed(trench.id)">
            <el-button size="small" @click="openEdit(trench)">编辑</el-button>
            <el-button size="small" type="warning" plain :disabled="trench.backfilled" @click="openSealDialog(trench)">
              回填确认并封存
            </el-button>
            <el-button size="small" type="danger" plain @click="remove(trench)">删除</el-button>
          </template>
          <template v-else>
            <el-tooltip content="封存版本只读，请开启复勘草稿后修改" placement="top">
              <span><el-button size="small" disabled>编辑</el-button></span>
            </el-tooltip>
            <el-button size="small" type="primary" plain @click="startRework(trench)">
              {{ draftOf(trench.id) ? '继续复勘' : '复勘修正' }}
            </el-button>
            <el-button size="small" @click="viewArchive(trench)">封存版本（{{ sealState.versionsOf(trench.id).length }}）</el-button>
          </template>
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
                <el-option v-for="item in ['5×5 米', '10×10 米', '5×10 米', '2×10 米']" :key="item" :label="item" :value="item" />
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
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sealDialogVisible" title="回填确认 · 封存第一版" width="520px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="封存后探方、地层单位、出土物与层位关系冻结为只读"
        description="之后的改正不会直接改动本版编目与历史导出，需从封存版开启复勘草稿，提交后生成新版本，旧版仍可查看导出。"
        class="seal-alert"
      />
      <el-form label-width="92px" v-if="sealingTrench">
        <el-form-item label="探方">
          <span class="mono">{{ trenchKey(sealingTrench) }} · {{ unitsOf(sealingTrench.id) }} 个单位 · {{ artifactsOf(sealingTrench.id) }} 件出土物</span>
        </el-form-item>
        <el-form-item label="确认人">
          <el-input v-model="sealForm.sealedBy" placeholder="回填确认记录员" />
        </el-form-item>
        <el-form-item label="封存说明">
          <el-input v-model="sealForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sealDialogVisible = false">取消</el-button>
        <el-button type="warning" @click="confirmSeal">确认回填并封存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.trench-card {
  border-radius: 12px;
}
.trench-card.sealed {
  background: #f6f7f9;
  border-color: #d7dde4;
}
.seal-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #eef1f5;
  color: #5b6672;
  font-size: 12px;
}
.draft-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #fdf6e7;
  color: #8a5a2b;
  font-size: 12px;
}
.seal-alert {
  margin-bottom: 14px;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
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
