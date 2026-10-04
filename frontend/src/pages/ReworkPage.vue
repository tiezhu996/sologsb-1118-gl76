<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  Artifact,
  ArtifactCategory,
  Completeness,
  Inclusion,
  Relation,
  RelationBasis,
  RelationType,
  ReworkDraft,
  Stratum,
  TrenchSize,
  UnitType
} from '@/types'
import {
  ARTIFACT_CATEGORIES,
  COMPLETENESS,
  INCLUSIONS,
  RELATION_BASES,
  RELATION_TYPES,
  UNIT_TYPES,
  isCodeDuplicated,
  isDepthInverted
} from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { sealStore } from '@/stores/sealStore'
import { isBaseStaleError } from '@/utils/errors'
import { wouldCreateCycle } from '@/utils/graph'
import { snapshotEqual } from '@/utils/snapshot'
import { diffSnapshots, diffSummary } from '@/utils/diff'
import SnapshotDiffViewer from '@/components/common/SnapshotDiffViewer.vue'
import { uid } from '@/utils/id'

const route = useRoute()
const router = useRouter()
const sealState = useStore(sealStore)

const activeTab = ref<'trench' | 'strata' | 'artifacts' | 'relations' | 'compare'>('strata')

const draftId = ref(typeof route.query.draft === 'string' ? route.query.draft : '')

const draft = computed<ReworkDraft | null>(() =>
  draftId.value ? sealState.drafts.find((item) => item.id === draftId.value) ?? null : null
)

/** 草稿依据的基底封存版（未变基前即提交校验版本） */
const baseVersion = computed(() =>
  draft.value ? sealState.versions.find((item) => item.trenchId === draft.value!.trenchId && item.versionNo === draft.value!.baseVersionNo) ?? null : null
)

/** 该探方当前最新封存版（其他标签页提交后会大于草稿基底） */
const latestVersion = computed(() => (draft.value ? sealState.latestVersionOf(draft.value.trenchId) : null))

/** 基底是否已过期（双标签页并发提交的后提交方） */
const isStale = computed(() => Boolean(draft.value && latestVersion.value && latestVersion.value.versionNo !== draft.value.baseVersionNo))

const work = computed(() => draft.value?.work ?? null)

const hasEdits = computed(() => Boolean(work.value && baseVersion.value && !snapshotEqual(baseVersion.value.snapshot, work.value)))

const trenchLabel = computed(() => {
  const t = work.value?.trench
  return t ? `${t.area} · ${t.code}` : '未知探方'
})

/* ------------------------------ 草稿选择 / 守卫 ------------------------------ */

watch(
  () => [sealState.drafts.length, draftId.value] as const,
  () => {
    if (!draftId.value && sealState.drafts.length > 0) {
      draftId.value = sealState.drafts[0].id
    }
  },
  { immediate: true }
)

watch(draftId, (id) => {
  router.replace({ query: id ? { draft: id } : {} })
})

function backToTrenches(): void {
  router.push('/trenches')
}

async function persist(mutator: (d: ReworkDraft) => void): Promise<void> {
  if (!draft.value) return
  await sealStore.getState().mutateDraft(draft.value.id, mutator)
}

/* -------------------------------- 探方信息表单 -------------------------------- */

const trenchForm = reactive<{
  size: TrenchSize
  basePoint: string
  openLayer: string
  startDate: string
  endDate: string
  leader: string
  wallNote: string
}>({
  size: '5×5 米',
  basePoint: '',
  openLayer: '',
  startDate: '',
  endDate: '',
  leader: '',
  wallNote: ''
})

watch(
  work,
  (snapshot) => {
    if (!snapshot) return
    Object.assign(trenchForm, {
      size: snapshot.trench.size,
      basePoint: snapshot.trench.basePoint,
      openLayer: snapshot.trench.openLayer,
      startDate: snapshot.trench.startDate,
      endDate: snapshot.trench.endDate,
      leader: snapshot.trench.leader,
      wallNote: snapshot.trench.wallNote
    })
  },
  { immediate: true }
)

async function saveTrench(): Promise<void> {
  await persist((d) => {
    d.work.trench = { ...d.work.trench, ...{
      size: trenchForm.size,
      basePoint: trenchForm.basePoint.trim(),
      openLayer: trenchForm.openLayer.trim(),
      startDate: trenchForm.startDate,
      endDate: trenchForm.endDate,
      leader: trenchForm.leader.trim(),
      wallNote: trenchForm.wallNote.trim()
    } }
  })
  ElMessage.success('探方信息已更新到草稿')
}

/* -------------------------------- 地层单位编辑 -------------------------------- */

const stratumDialog = ref(false)
const stratumEditingId = ref<string | null>(null)
const stratumForm = reactive({
  code: '',
  type: '地层' as UnitType,
  openLayer: '第①层',
  topDepth: 0,
  bottomDepth: 0.3,
  soil: '',
  inclusions: [] as Inclusion[],
  formation: '',
  date: new Date().toISOString().slice(0, 10),
  drawingNo: ''
})

function resetStratumForm(): void {
  stratumEditingId.value = null
  Object.assign(stratumForm, {
    code: '',
    type: '地层',
    openLayer: '第①层',
    topDepth: 0,
    bottomDepth: 0.3,
    soil: '',
    inclusions: [],
    formation: '',
    date: new Date().toISOString().slice(0, 10),
    drawingNo: ''
  })
}

function openStratumCreate(): void {
  resetStratumForm()
  stratumDialog.value = true
}

function openStratumEdit(stratum: Stratum): void {
  stratumEditingId.value = stratum.id
  Object.assign(stratumForm, {
    code: stratum.code,
    type: stratum.type,
    openLayer: stratum.openLayer,
    topDepth: stratum.topDepth,
    bottomDepth: stratum.bottomDepth,
    soil: stratum.soil,
    inclusions: [...stratum.inclusions],
    formation: stratum.formation,
    date: stratum.date,
    drawingNo: stratum.drawingNo
  })
  stratumDialog.value = true
}

async function saveStratum(): Promise<void> {
  if (!work.value) return
  if (!stratumForm.code.trim()) {
    ElMessage.warning('请填写单位号')
    return
  }
  const code = stratumForm.code.trim().toUpperCase()
  const duplicated = work.value.strata.some(
    (item) => item.id !== stratumEditingId.value && item.code.trim().toUpperCase() === code
  )
  if (duplicated) {
    ElMessage.error(`同一探方内单位号「${code}」已存在`)
    return
  }
  await persist((d) => {
    if (stratumEditingId.value) {
      d.work.strata = d.work.strata.map((item) =>
        item.id === stratumEditingId.value
          ? {
              ...item,
              code,
              type: stratumForm.type,
              openLayer: stratumForm.openLayer.trim(),
              topDepth: Number(stratumForm.topDepth) || 0,
              bottomDepth: Number(stratumForm.bottomDepth) || 0,
              soil: stratumForm.soil.trim(),
              inclusions: [...stratumForm.inclusions],
              formation: stratumForm.formation.trim(),
              date: stratumForm.date,
              drawingNo: stratumForm.drawingNo.trim()
            }
          : item
      )
    } else {
      d.work.strata.push({
        id: uid('st'),
        trenchId: d.trenchId,
        code,
        type: stratumForm.type,
        openLayer: stratumForm.openLayer.trim(),
        topDepth: Number(stratumForm.topDepth) || 0,
        bottomDepth: Number(stratumForm.bottomDepth) || 0,
        soil: stratumForm.soil.trim(),
        inclusions: [...stratumForm.inclusions],
        formation: stratumForm.formation.trim(),
        date: stratumForm.date,
        drawingNo: stratumForm.drawingNo.trim()
      })
    }
  })
  ElMessage.success(stratumEditingId.value ? '地层单位已在草稿中更新' : '地层单位已加入草稿')
  stratumDialog.value = false
}

async function removeStratum(stratum: Stratum): Promise<void> {
  const artifactsCount = work.value?.artifacts.filter((item) => item.stratumId === stratum.id).length ?? 0
  const relationsCount =
    work.value?.relations.filter((item) => item.unitAId === stratum.id || item.unitBId === stratum.id).length ?? 0
  if (artifactsCount > 0 || relationsCount > 0) {
    ElMessage.error(`「${stratum.code}」下仍有 ${artifactsCount} 件出土物、${relationsCount} 条关系，请先在草稿中清理`)
    return
  }
  await ElMessageBox.confirm(`确认在草稿中删除地层单位「${stratum.code}」？（封存版不受影响）`, '草稿删除', { type: 'warning' })
  await persist((d) => {
    d.work.strata = d.work.strata.filter((item) => item.id !== stratum.id)
  })
  ElMessage.success('已从草稿中删除')
}

/* --------------------------------- 出土物编辑 --------------------------------- */

const artifactDialog = ref(false)
const artifactEditingId = ref<string | null>(null)
const artifactForm = reactive({
  stratumId: '',
  code: '',
  category: '陶器' as ArtifactCategory,
  count: 1,
  completeness: '残片' as Completeness,
  x: 2.5,
  y: 2.5,
  z: 0.5,
  date: new Date().toISOString().slice(0, 10),
  collector: '',
  tempLocation: ''
})

watch(
  work,
  (snapshot) => {
    if (snapshot && !snapshot.strata.some((item) => item.id === artifactForm.stratumId)) {
      artifactForm.stratumId = snapshot.strata[0]?.id ?? ''
    }
  },
  { immediate: true }
)

function resetArtifactForm(): void {
  artifactEditingId.value = null
  Object.assign(artifactForm, {
    stratumId: work.value?.strata[0]?.id ?? '',
    code: '',
    category: '陶器',
    count: 1,
    completeness: '残片',
    x: 2.5,
    y: 2.5,
    z: 0.5,
    date: new Date().toISOString().slice(0, 10),
    collector: '',
    tempLocation: ''
  })
}

function openArtifactCreate(): void {
  resetArtifactForm()
  artifactDialog.value = true
}

function openArtifactEdit(artifact: Artifact): void {
  artifactEditingId.value = artifact.id
  Object.assign(artifactForm, {
    stratumId: artifact.stratumId,
    code: artifact.code,
    category: artifact.category,
    count: artifact.count,
    completeness: artifact.completeness,
    x: artifact.x,
    y: artifact.y,
    z: artifact.z,
    date: artifact.date,
    collector: artifact.collector,
    tempLocation: artifact.tempLocation
  })
  artifactDialog.value = true
}

async function saveArtifact(): Promise<void> {
  if (!artifactForm.stratumId) {
    ElMessage.warning('请选择所属地层单位')
    return
  }
  if (!artifactForm.code.trim()) {
    ElMessage.warning('请填写器物编号')
    return
  }
  const unit = work.value?.strata.find((item) => item.id === artifactForm.stratumId)
  if (unit && (artifactForm.z < unit.topDepth || artifactForm.z > unit.bottomDepth)) {
    ElMessage.warning(`出土深度 ${artifactForm.z} m 不在「${unit.code}」深度区间（${unit.topDepth}–${unit.bottomDepth} m）内`)
    return
  }
  await persist((d) => {
    const row: Artifact = {
      id: artifactEditingId.value ?? uid('af'),
      stratumId: artifactForm.stratumId,
      code: artifactForm.code.trim(),
      category: artifactForm.category,
      count: Number(artifactForm.count) || 1,
      completeness: artifactForm.completeness,
      x: Number(artifactForm.x) || 0,
      y: Number(artifactForm.y) || 0,
      z: Number(artifactForm.z) || 0,
      date: artifactForm.date,
      collector: artifactForm.collector.trim(),
      tempLocation: artifactForm.tempLocation.trim()
    }
    if (artifactEditingId.value) {
      d.work.artifacts = d.work.artifacts.map((item) => (item.id === row.id ? row : item))
    } else {
      d.work.artifacts.push(row)
    }
  })
  ElMessage.success(artifactEditingId.value ? '出土物已在草稿中更新' : '出土物已加入草稿')
  artifactDialog.value = false
}

async function removeArtifact(artifact: Artifact): Promise<void> {
  await ElMessageBox.confirm(`确认在草稿中删除出土物「${artifact.code}」？（封存版不受影响）`, '草稿删除', { type: 'warning' })
  await persist((d) => {
    d.work.artifacts = d.work.artifacts.filter((item) => item.id !== artifact.id)
  })
  ElMessage.success('已从草稿中删除')
}

function unitCodeInWork(unitId: string): string {
  return work.value?.strata.find((item) => item.id === unitId)?.code ?? '未知单位'
}

/* -------------------------------- 层位关系编辑 -------------------------------- */

const relationDialog = ref(false)
const relationEditingId = ref<string | null>(null)
const relationForm = reactive({
  unitAId: '',
  type: '叠压' as RelationType,
  unitBId: '',
  basis: '剖面观察' as RelationBasis,
  recorder: '',
  note: ''
})

watch(
  work,
  (snapshot) => {
    if (!snapshot) return
    if (!snapshot.strata.some((item) => item.id === relationForm.unitAId)) relationForm.unitAId = snapshot.strata[0]?.id ?? ''
    if (!snapshot.strata.some((item) => item.id === relationForm.unitBId)) {
      relationForm.unitBId = snapshot.strata[1]?.id ?? snapshot.strata[0]?.id ?? ''
    }
  },
  { immediate: true }
)

function resetRelationForm(): void {
  relationEditingId.value = null
  Object.assign(relationForm, {
    unitAId: work.value?.strata[0]?.id ?? '',
    type: '叠压',
    unitBId: work.value?.strata[1]?.id ?? work.value?.strata[0]?.id ?? '',
    basis: '剖面观察',
    recorder: '',
    note: ''
  })
}

function openRelationCreate(): void {
  resetRelationForm()
  relationDialog.value = true
}

function openRelationEdit(relation: Relation): void {
  relationEditingId.value = relation.id
  Object.assign(relationForm, {
    unitAId: relation.unitAId,
    type: relation.type,
    unitBId: relation.unitBId,
    basis: relation.basis,
    recorder: relation.recorder,
    note: relation.note
  })
  relationDialog.value = true
}

async function saveRelation(): Promise<void> {
  if (!relationForm.unitAId || !relationForm.unitBId) {
    ElMessage.warning('请选择单位 A 与单位 B')
    return
  }
  if (relationForm.unitAId === relationForm.unitBId) {
    ElMessage.error('单位 A 与单位 B 不能相同')
    return
  }
  const others = (work.value?.relations ?? []).filter((item) => item.id !== relationEditingId.value)
  if (wouldCreateCycle(others, { unitAId: relationForm.unitAId, unitBId: relationForm.unitBId, type: relationForm.type })) {
    ElMessage.error('该关系会形成环路矛盾，无法写入草稿')
    return
  }
  await persist((d) => {
    const row: Relation = {
      id: relationEditingId.value ?? uid('rl'),
      unitAId: relationForm.unitAId,
      type: relationForm.type,
      unitBId: relationForm.unitBId,
      basis: relationForm.basis,
      recorder: relationForm.recorder.trim(),
      note: relationForm.note.trim()
    }
    if (relationEditingId.value) {
      d.work.relations = d.work.relations.map((item) => (item.id === row.id ? row : item))
    } else {
      d.work.relations.push(row)
    }
  })
  ElMessage.success(relationEditingId.value ? '层位关系已在草稿中更新' : '层位关系已加入草稿')
  relationDialog.value = false
}

async function removeRelation(relation: Relation): Promise<void> {
  await ElMessageBox.confirm('确认在草稿中删除该层位关系？（封存版不受影响）', '草稿删除', { type: 'warning' })
  await persist((d) => {
    d.work.relations = d.work.relations.filter((item) => item.id !== relation.id)
  })
  ElMessage.success('已从草稿中删除')
}

/* --------------------------------- 提交 / 放弃 --------------------------------- */

const diffDialogVisible = ref(false)
const commitNote = ref('')
const commitBy = ref('')
const submitting = ref(false)

const draftDiff = computed(() =>
  work.value && baseVersion.value ? diffSnapshots(baseVersion.value.snapshot, work.value) : null
)

const diffSummaryText = computed(() => (draftDiff.value ? diffSummary(draftDiff.value) : ''))

function openCommitReview(): void {
  if (!hasEdits.value) {
    ElMessage.info('草稿与基底封存版一致，没有可提交的改动')
    return
  }
  if (isStale.value) {
    ElMessage.warning(`基底已过期：最新已是第 ${latestVersion.value?.versionNo} 版，请先在下方比对并「变基到最新版」后再提交`)
    return
  }
  commitBy.value = draft.value?.createdBy ?? work.value?.trench.leader ?? ''
  commitNote.value = `复勘第 ${(latestVersion.value?.versionNo ?? 0) + 1} 版`
  diffDialogVisible.value = true
}

async function confirmCommit(): Promise<void> {
  if (!draft.value) return
  submitting.value = true
  try {
    const version = await sealStore.getState().commitDraft(draft.value.id, {
      sealedBy: commitBy.value,
      note: commitNote.value
    })
    ElMessage.success(`复勘已提交，生成第 ${version.versionNo} 版封存；旧版仍可在封存版本中查看导出`)
    diffDialogVisible.value = false
    draftId.value = ''
    router.push({ path: '/archive', query: { trench: version.trenchId, version: version.id } })
  } catch (error) {
    if (isBaseStaleError(error)) {
      ElMessage.error(error.message)
    } else {
      throw error
    }
  } finally {
    submitting.value = false
  }
}

/** 基底过期后：以最新封存版为基底重放草稿工作副本（草稿保留，仅更新基底版本号） */
async function rebaseDraft(): Promise<void> {
  if (!draft.value || !latestVersion.value) return
  await ElMessageBox.confirm(
    `变基会把本草稿的基底更新为第 ${latestVersion.value.versionNo} 版，草稿中的改动全部保留。请在比对确认无冲突后再提交。确认变基？`,
    '变基到最新封存版',
    { type: 'warning', confirmButtonText: '变基并保留草稿' }
  )
  await persist((d) => {
    d.baseVersionNo = latestVersion.value!.versionNo
  })
  ElMessage.success(`已变基到第 ${latestVersion.value.versionNo} 版，可核对差异后重新提交`)
}

async function discard(): Promise<void> {
  if (!draft.value) return
  await ElMessageBox.confirm(
    `确认放弃「${trenchLabel.value}」的复勘草稿？草稿改动将全部清除，封存版本不受影响。`,
    '放弃复勘草稿',
    { type: 'warning', confirmButtonText: '放弃草稿' }
  )
  const id = draft.value.id
  await sealStore.getState().discardDraft(id)
  ElMessage.success('复勘草稿已放弃')
  draftId.value = ''
}
</script>

<template>
  <div class="page rework-page">
    <template v-if="sealState.drafts.length === 0 || !draft">
      <el-empty description="没有进行中的复勘草稿">
        <el-button type="primary" @click="backToTrenches">回到探方清单，从封存版开启复勘</el-button>
      </el-empty>
    </template>

    <template v-else-if="work">
      <div class="page-head">
        <div>
          <h2 class="page-title">复勘工作台 · {{ trenchLabel }}</h2>
          <p class="page-sub">
            草稿基于第 {{ draft.baseVersionNo }} 版封存快照；所有改动只作用于本草稿，实时档案保持只读，提交成功才生成新版本。
          </p>
        </div>
        <el-button @click="backToTrenches">返回探方清单</el-button>
      </div>

      <el-alert
        v-if="isStale"
        class="alert"
        type="error"
        :closable="false"
        show-icon
        :title="`基底已过期：本草稿基于第 ${draft.baseVersionNo} 版，第 ${latestVersion?.versionNo} 版已由其他记录员提交`"
      >
        <template #default>
          <p>草稿已保留未被覆盖。请先在下方「与最新版比对」核对差异，变基到最新版后重新提交。</p>
          <el-button size="small" type="warning" @click="rebaseDraft">变基到第 {{ latestVersion?.versionNo }} 版（保留草稿改动）</el-button>
          <el-button size="small" @click="activeTab = 'compare'">查看与最新版差异</el-button>
        </template>
      </el-alert>
      <el-alert
        v-else
        class="alert"
        :type="hasEdits ? 'warning' : 'success'"
        :closable="false"
        show-icon
        :title="hasEdits ? `草稿已有未提交改动：${diffSummaryText}` : '草稿与第 ' + draft.baseVersionNo + ' 版封存内容一致'"
      />

      <el-card shadow="never" class="meta-card">
        <div class="meta-row">
          <span>复勘事由：{{ draft.reason }}</span>
          <span>发起人：{{ draft.createdBy }}</span>
          <span>建稿：{{ draft.createdAt.slice(0, 16).replace('T', ' ') }}</span>
          <span>最近修改：{{ draft.updatedAt.slice(0, 16).replace('T', ' ') }}</span>
        </div>
      </el-card>

      <el-tabs v-model="activeTab" class="tabs">
        <!-- 探方信息 -->
        <el-tab-pane name="trench">
          <template #label><el-icon><Document /></el-icon>&nbsp;探方信息</template>
          <el-form label-width="110px" class="pane-form">
            <el-row :gutter="12">
              <el-col :span="8">
                <el-form-item label="规格">
                  <el-select v-model="trenchForm.size" style="width: 100%">
                    <el-option v-for="item in ['5×5 米', '10×10 米', '5×10 米', '2×10 米']" :key="item" :label="item" :value="item" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="基点坐标"><el-input v-model="trenchForm.basePoint" /></el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="开口层位"><el-input v-model="trenchForm.openLayer" /></el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="负责人"><el-input v-model="trenchForm.leader" /></el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="发掘起始">
                  <el-date-picker v-model="trenchForm.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="发掘结束">
                  <el-date-picker v-model="trenchForm.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
                </el-form-item>
              </el-col>
              <el-col :span="24">
                <el-form-item label="四壁备注"><el-input v-model="trenchForm.wallNote" type="textarea" :rows="2" /></el-form-item>
              </el-col>
            </el-row>
            <el-button type="primary" @click="saveTrench">保存到草稿</el-button>
          </el-form>
        </el-tab-pane>

        <!-- 地层单位 -->
        <el-tab-pane name="strata">
          <template #label><el-icon><Files /></el-icon>&nbsp;地层单位（{{ work.strata.length }}）</template>
          <div class="pane-head">
            <el-button type="primary" size="small" @click="openStratumCreate">新增单位到草稿</el-button>
            <el-tag size="small" type="info" effect="plain">单位号重复 / 层序倒置仍会校验</el-tag>
          </div>
          <el-table :data="work.strata" size="small" border>
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
            <el-table-column label="校验" width="100">
              <template #default="{ row }">
                <el-tag v-if="isDepthInverted(row)" type="danger" size="small" effect="dark">层序倒置</el-tag>
                <el-tag
                  v-else-if="isCodeDuplicated(work.strata, row)"
                  type="warning"
                  size="small"
                  effect="dark"
                >号重复</el-tag>
                <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openStratumEdit(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeStratum(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 出土物 -->
        <el-tab-pane name="artifacts">
          <template #label><el-icon><Box /></el-icon>&nbsp;出土物（{{ work.artifacts.length }}）</template>
          <div class="pane-head">
            <el-button type="primary" size="small" :disabled="work.strata.length === 0" @click="openArtifactCreate">新增出土物到草稿</el-button>
          </div>
          <el-table :data="work.artifacts" size="small" border>
            <el-table-column prop="code" label="器物编号" width="140" />
            <el-table-column label="所属单位" width="100">
              <template #default="{ row }">{{ unitCodeInWork(row.stratumId) }}</template>
            </el-table-column>
            <el-table-column prop="category" label="类别" width="80" />
            <el-table-column prop="count" label="件数" width="70" />
            <el-table-column prop="completeness" label="残整" width="90" />
            <el-table-column label="X,Y,Z" width="150">
              <template #default="{ row }">{{ row.x }}, {{ row.y }}, {{ row.z }}</template>
            </el-table-column>
            <el-table-column prop="collector" label="提取人" width="90" />
            <el-table-column label="操作" width="120">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openArtifactEdit(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeArtifact(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- 层位关系 -->
        <el-tab-pane name="relations">
          <template #label><el-icon><Share /></el-icon>&nbsp;层位关系（{{ work.relations.length }}）</template>
          <div class="pane-head">
            <el-button type="primary" size="small" :disabled="work.strata.length < 2" @click="openRelationCreate">新增关系到草稿</el-button>
          </div>
          <ul class="rel-list">
            <li v-for="relation in work.relations" :key="relation.id">
              <span class="mono">{{ unitCodeInWork(relation.unitAId) }}</span>
              <el-tag size="small" effect="dark" class="type">{{ relation.type }}</el-tag>
              <span class="mono">{{ unitCodeInWork(relation.unitBId) }}</span>
              <span class="muted">（{{ relation.basis }} · {{ relation.recorder || '未填记录人' }}）{{ relation.note }}</span>
              <span class="ops">
                <el-button link type="primary" size="small" @click="openRelationEdit(relation)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeRelation(relation)">删除</el-button>
              </span>
            </li>
            <li v-if="work.relations.length === 0" class="muted">本草稿暂无层位关系</li>
          </ul>
        </el-tab-pane>

        <!-- 差异比对 -->
        <el-tab-pane name="compare">
          <template #label><el-icon><Switch /></el-icon>&nbsp;差异比对</template>
          <SnapshotDiffViewer
            v-if="isStale && latestVersion"
            :base="latestVersion.snapshot"
            :draft="work"
            :latest="latestVersion.snapshot"
            :base-version-no="draft.baseVersionNo"
            :latest-version-no="latestVersion.versionNo"
          />
          <SnapshotDiffViewer v-else-if="baseVersion" :base="baseVersion.snapshot" :draft="work" />
        </el-tab-pane>
      </el-tabs>

      <div class="footer-bar">
        <el-button type="danger" plain @click="discard">放弃草稿</el-button>
        <el-button @click="activeTab = 'compare'">查看差异</el-button>
        <el-button type="primary" :disabled="!hasEdits || isStale" @click="openCommitReview">
          比对并提交复勘
        </el-button>
      </div>
    </template>

    <!-- 地层单位弹窗 -->
    <el-dialog v-model="stratumDialog" :title="stratumEditingId ? '草稿中编辑地层单位' : '新增地层单位到草稿'" width="640px">
      <el-form label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="单位号" required><el-input v-model="stratumForm.code" placeholder="如 H12、L03" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="单位类型">
              <el-select v-model="stratumForm.type" style="width: 100%">
                <el-option v-for="item in UNIT_TYPES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="上界深度"><el-input-number v-model="stratumForm.topDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="下界深度"><el-input-number v-model="stratumForm.bottomDepth" :min="0" :step="0.05" :precision="2" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="开口层位"><el-input v-model="stratumForm.openLayer" /></el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="土质土色"><el-input v-model="stratumForm.soil" /></el-form-item>
        <el-form-item label="包含物">
          <el-checkbox-group v-model="stratumForm.inclusions">
            <el-checkbox v-for="item in INCLUSIONS" :key="item" :value="item">{{ item }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="堆积成因"><el-input v-model="stratumForm.formation" /></el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="日期">
              <el-date-picker v-model="stratumForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="绘图/拍照号"><el-input v-model="stratumForm.drawingNo" /></el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="stratumDialog = false">取消</el-button>
        <el-button type="primary" @click="saveStratum">保存到草稿</el-button>
      </template>
    </el-dialog>

    <!-- 出土物弹窗 -->
    <el-dialog v-model="artifactDialog" :title="artifactEditingId ? '草稿中编辑出土物' : '新增出土物到草稿'" width="640px">
      <el-form label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="所属单位" required>
              <el-select v-model="artifactForm.stratumId" style="width: 100%" :disabled="Boolean(artifactEditingId)">
                <el-option v-for="item in work?.strata ?? []" :key="item.id" :label="`${item.code}（${item.topDepth}–${item.bottomDepth} m）`" :value="item.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="器物编号" required><el-input v-model="artifactForm.code" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="类别">
              <el-select v-model="artifactForm.category" style="width: 100%">
                <el-option v-for="item in ARTIFACT_CATEGORIES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="件数"><el-input-number v-model="artifactForm.count" :min="1" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="残整程度">
              <el-select v-model="artifactForm.completeness" style="width: 100%">
                <el-option v-for="item in COMPLETENESS" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="X(m)"><el-input-number v-model="artifactForm.x" :min="0" :max="10" :step="0.1" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="Y(m)"><el-input-number v-model="artifactForm.y" :min="0" :max="10" :step="0.1" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="Z 深度(m)"><el-input-number v-model="artifactForm.z" :min="0" :max="10" :step="0.01" :precision="2" :controls="false" style="width: 100%" /></el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出土日期">
              <el-date-picker v-model="artifactForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="提取人"><el-input v-model="artifactForm.collector" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="临时存放"><el-input v-model="artifactForm.tempLocation" /></el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="artifactDialog = false">取消</el-button>
        <el-button type="primary" @click="saveArtifact">保存到草稿</el-button>
      </template>
    </el-dialog>

    <!-- 层位关系弹窗 -->
    <el-dialog v-model="relationDialog" :title="relationEditingId ? '草稿中编辑层位关系' : '新增层位关系到草稿'" width="560px">
      <el-form label-width="92px">
        <el-form-item label="单位 A" required>
          <el-select v-model="relationForm.unitAId" style="width: 100%">
            <el-option v-for="item in work?.strata ?? []" :key="item.id" :label="`${item.code}（${item.type}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关系类型">
          <el-select v-model="relationForm.type" style="width: 100%">
            <el-option v-for="item in RELATION_TYPES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="单位 B" required>
          <el-select v-model="relationForm.unitBId" style="width: 100%">
            <el-option v-for="item in work?.strata ?? []" :key="item.id" :label="`${item.code}（${item.type}）`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="判定依据">
          <el-select v-model="relationForm.basis" style="width: 100%">
            <el-option v-for="item in RELATION_BASES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="记录人"><el-input v-model="relationForm.recorder" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="relationForm.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="relationDialog = false">取消</el-button>
        <el-button type="primary" @click="saveRelation">保存到草稿</el-button>
      </template>
    </el-dialog>

    <!-- 提交确认 -->
    <el-dialog v-model="diffDialogVisible" title="比对复勘改动并提交" width="780px" top="6vh">
      <SnapshotDiffViewer v-if="baseVersion && work" :base="baseVersion.snapshot" :draft="work" />
      <el-form label-width="92px" class="commit-form">
        <el-form-item label="新版本确认人">
          <el-input v-model="commitBy" placeholder="复勘提交记录员" />
        </el-form-item>
        <el-form-item label="版本说明">
          <el-input v-model="commitNote" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="diffDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmCommit">
          提交并生成第 {{ (latestVersion?.versionNo ?? 0) + 1 }} 版
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.meta-card {
  margin-bottom: 12px;
  border-radius: 10px;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  font-size: 12px;
  color: #6b5b45;
}
.tabs {
  background: #fff;
  border-radius: 12px;
  padding: 4px 16px 12px;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.pane-form {
  max-width: 760px;
  padding-top: 8px;
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
.ops {
  margin-left: auto;
}
.muted {
  color: #8a8073;
  font-size: 12px;
}
.footer-bar {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 16px;
  border-radius: 12px;
  background: #f7f4ee;
}
.commit-form {
  margin-top: 12px;
}
</style>
