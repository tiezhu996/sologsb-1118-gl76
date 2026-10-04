<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { SurveyDraft } from '@/types'
import type { EntityDiff, WorkspaceDiff } from '@/utils/diff'
import { StaleBaseError, commitDraft, rebaseDraft } from '@/services/archiveService'
import { archiveStore } from '@/stores/archiveStore'
import { emitArchiveEvent } from '@/hooks/useArchiveEvents'

const props = defineProps<{ modelValue: boolean; draft: SurveyDraft | null }>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'committed', draftId: string): void
  (event: 'draft-rebased', draftId: string): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const submitting = ref(false)
const rebasing = ref(false)
const note = ref('')
/** rebase 后无冲突、可立即重交的状态（草稿已并入最新版） */
const rebasedClean = ref(false)

/** 基底过期时的三方比对 */
const stale = ref<StaleBaseError | null>(null)
const diff = computed<WorkspaceDiff | null>(() => stale.value?.diff ?? null)
const conflictCount = computed(() => {
  if (!diff.value) return 0
  return [diff.value.trench, ...diff.value.strata, ...diff.value.artifacts, ...diff.value.relations].filter(
    (item) => item.rowConflict || item.fields.some((field) => field.conflicting)
  ).length
})

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      stale.value = null
      rebasedClean.value = false
      note.value = ''
    }
  }
)

async function submit(): Promise<void> {
  if (!props.draft) return
  submitting.value = true
  try {
    const result = await commitDraft(props.draft.id, note.value.trim() || '复勘改定封存')
    await archiveStore.getState().hydrate()
    emitArchiveEvent('draft-committed', {
      trenchId: result.draft.trenchId,
      draftId: result.draft.id,
      version: result.version
    })
    ElMessage.success(`已按草稿生成封存 v${result.version.versionNo}，旧版本仍可查看导出`)
    visible.value = false
    emit('committed', result.draft.id)
  } catch (error) {
    if (error instanceof StaleBaseError) {
      stale.value = error
      rebasedClean.value = false
      ElMessage.warning(`基底版本 v${error.base.versionNo} 已过期：另一标签页已提交 v${error.head.versionNo}，草稿已保留`)
    } else {
      ElMessage.error(error instanceof Error ? error.message : '提交失败')
    }
  } finally {
    submitting.value = false
  }
}

async function rebase(): Promise<void> {
  if (!props.draft) return
  rebasing.value = true
  try {
    const result = await rebaseDraft(props.draft.id)
    await archiveStore.getState().hydrate()
    emitArchiveEvent('draft-opened', { trenchId: result.draft.trenchId, draftId: result.draft.id })
    if (result.conflicts) {
      ElMessage.warning('已并入最新封存版的改动；标红字段双方都改过且保留了你的草稿值，请回页面核对后再提交')
      emit('update:modelValue', false)
    } else {
      ElMessage.success('已并入最新封存版的改动，无冲突，可直接重新提交')
      // 无冲突：留在对话框，让记录员直接再次点「提交封存新版本」
      stale.value = null
      rebasedClean.value = true
    }
    emit('draft-rebased', result.draft.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '并入失败')
  } finally {
    rebasing.value = false
  }
}

const tabs = [
  { key: 'strata', label: '地层单位' },
  { key: 'artifacts', label: '出土物' },
  { key: 'relations', label: '层位关系' },
  { key: 'trench', label: '探方信息' }
] as const

const activeTab = ref<(typeof tabs)[number]['key']>('strata')

function rowsOf(key: string): EntityDiff[] {
  if (!diff.value) return []
  if (key === 'trench') return [diff.value.trench]
  if (key === 'strata') return diff.value.strata
  if (key === 'artifacts') return diff.value.artifacts
  return diff.value.relations
}

const STATUS_TEXT: Record<EntityDiff['status'], string> = {
  added: '草稿新增',
  removed: '草稿删除',
  modified: '草稿修改',
  headChanged: '最新版已改',
  unchanged: '未改'
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="stale ? '基底已过期：提交冲突（草稿已保留）' : rebasedClean ? '重新提交（已并入最新版）' : '提交复勘草稿'"
    width="860px"
    :close-on-click-modal="false"
  >
    <!-- 正常提交 -->
    <template v-if="!stale">
      <el-alert
        :type="rebasedClean ? 'success' : 'info'"
        :closable="false"
        show-icon
        :title="
          rebasedClean
            ? '已并入最新封存版且无冲突，直接提交即可基于最新版生成新封存版本。'
            : '提交后将基于当前草稿生成新的封存版本；旧封存版本保持不变，仍可查看与导出。'
        "
        style="margin-bottom: 12px"
      />
      <el-form label-width="100px">
        <el-form-item label="封存说明">
          <el-input v-model="note" type="textarea" :rows="3" placeholder="如 复勘改正 H12 深度区间、补登两件出土物" />
        </el-form-item>
      </el-form>
    </template>

    <!-- 冲突三方比对 -->
    <template v-else>
      <el-alert type="error" :closable="false" show-icon style="margin-bottom: 12px">
        <template #title>
          另一标签页已先提交 v{{ stale.head.versionNo }}（{{ stale.head.createdAt.slice(0, 16).replace('T', ' ') }}），
          本草稿基于 v{{ stale.base.versionNo }}。草稿已保留，共 {{ conflictCount }} 处需核对。
        </template>
        <template #default>
          可「并入最新版改动后重交」：仅对方改过的部分自动并入；双方都改的行/字段保留本草稿值，请回页面核对后再提交。
        </template>
      </el-alert>

      <el-tabs v-model="activeTab">
        <el-tab-pane v-for="tab in tabs" :key="tab.key" :name="tab.key" :label="tab.label">
          <el-table :data="rowsOf(tab.key)" border size="small" max-height="360">
            <el-table-column label="状态" width="100">
              <template #default="{ row }: { row: EntityDiff }">
                <el-tag
                  :type="row.rowConflict || row.fields.some((f) => f.conflicting) ? 'danger' : row.status === 'headChanged' ? 'info' : 'warning'"
                  size="small"
                  effect="plain"
                >
                  {{ STATUS_TEXT[row.status] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="label" label="行" width="180" show-overflow-tooltip />
            <el-table-column label="字段级比对（基底 v{{ stale.base.versionNo }} → 最新 v{{ stale.head.versionNo }} / 本草稿）" min-width="420">
              <template #default="{ row }: { row: EntityDiff }">
                <div
                  v-for="field in row.fields.filter((f) => f.base !== f.head || f.base !== f.draft)"
                  :key="field.key"
                  class="field-diff"
                  :class="{ conflicting: field.conflicting }"
                >
                  <span class="field-label">{{ field.label }}</span>
                  <span class="cell base">{{ field.base }}</span>
                  <span class="arrow">→</span>
                  <span class="cell head">{{ field.head }}</span>
                  <span class="slash">/</span>
                  <span class="cell draft">{{ field.draft }}</span>
                </div>
                <p v-if="row.rowConflict && row.fields.length === 0" class="row-conflict">整行处理方式冲突，请回页面核对取舍</p>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="rowsOf(tab.key).length === 0" description="该分类无差异" :image-size="60" />
        </el-tab-pane>
      </el-tabs>
    </template>

    <template #footer>
      <template v-if="!stale">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交封存新版本</el-button>
      </template>
      <template v-else>
        <el-button @click="visible = false">返回草稿继续修改</el-button>
        <el-button type="primary" :loading="rebasing" @click="rebase">并入最新版改动后重交</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.field-diff {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}
.field-diff.conflicting {
  color: #c0392b;
  font-weight: 600;
}
.field-label {
  width: 76px;
  color: #7d7264;
  flex-shrink: 0;
}
.cell {
  padding: 0 6px;
  border-radius: 4px;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell.base {
  background: #f0ede6;
  color: #8a8073;
  text-decoration: line-through;
}
.cell.head {
  background: #e8f1e8;
  color: #2c6e3a;
}
.cell.draft {
  background: #fbecdd;
  color: #a9762f;
}
.arrow,
.slash {
  color: #b5a98f;
}
.row-conflict {
  color: #c0392b;
  font-size: 12px;
  margin: 4px 0;
}
</style>
