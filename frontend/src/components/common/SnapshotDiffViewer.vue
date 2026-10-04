<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SealedSnapshot } from '@/types'
import { diffSnapshots, diffSummary, type RecordDiff } from '@/utils/diff'

const activeNames = ref<string[]>(['trench', 'strata', 'artifacts', 'relations'])

const props = withDefaults(
  defineProps<{
    /** 基底封存版 */
    base: SealedSnapshot
    /** 待提交草稿 / 变基后草稿 */
    draft: SealedSnapshot
    /** 变基场景：最新封存版（用于顶部说明） */
    latest?: SealedSnapshot | null
    baseVersionNo?: number
    latestVersionNo?: number
  }>(),
  { latest: null, baseVersionNo: 0, latestVersionNo: 0 }
)

const diff = computed(() => diffSnapshots(props.base, props.draft))

const sections = computed(() => [
  { key: 'trench', data: diff.value.trench },
  { key: 'strata', data: diff.value.strata },
  { key: 'artifacts', data: diff.value.artifacts },
  { key: 'relations', data: diff.value.relations }
])

function countOf(data: RecordDiff): number {
  return data.added.length + data.removed.length + data.changed.length
}
</script>

<template>
  <div class="diff-viewer" data-testid="snapshot-diff">
    <el-alert
      :type="latest ? 'warning' : diff.hasChanges ? 'success' : 'info'"
      :closable="false"
      show-icon
      class="head"
      :title="
        latest
          ? `基底已过期：本草稿基于第 ${baseVersionNo} 版，第 ${latestVersionNo} 版已提交。下方为草稿相对原基底的改动，请核对后变基重交`
          : diff.hasChanges
            ? '本次复勘改动如下，提交后将生成新封存版本，旧版保持不变'
            : '草稿与基底封存版完全一致，没有任何改动'
      "
      :description="diffSummary(diff)"
    />

    <el-collapse v-model="activeNames" class="groups">
      <el-collapse-item
        v-for="section in sections"
        :key="section.key"
        :name="section.key"
        :title="`${section.data.entityLabel}（${countOf(section.data)} 处差异）`"
      >
        <template #title>
          <span class="group-title">
            {{ section.data.entityLabel }}
            <el-tag size="small" :type="countOf(section.data) > 0 ? 'warning' : 'success'" effect="plain">
              {{ countOf(section.data) }} 处
            </el-tag>
          </span>
        </template>

        <div v-if="countOf(section.data) === 0" class="muted">无改动</div>

        <div v-if="section.data.added.length > 0" class="block">
          <h5><el-tag type="success" size="small" effect="dark">新增 {{ section.data.added.length }}</el-tag></h5>
          <ul>
            <li v-for="item in section.data.added" :key="item.id" class="added">{{ item.label }}</li>
          </ul>
        </div>

        <div v-if="section.data.removed.length > 0" class="block">
          <h5><el-tag type="danger" size="small" effect="dark">删除 {{ section.data.removed.length }}</el-tag></h5>
          <ul>
            <li v-for="item in section.data.removed" :key="item.id" class="removed">
              <el-icon><Remove /></el-icon>{{ item.label }}
            </li>
          </ul>
        </div>

        <div v-if="section.data.changed.length > 0" class="block">
          <h5><el-tag type="warning" size="small" effect="dark">修改 {{ section.data.changed.length }}</el-tag></h5>
          <el-table :data="section.data.changed" size="small" border>
            <el-table-column prop="label" label="记录" width="150" />
            <el-table-column label="字段差异" min-width="360">
              <template #default="{ row }">
                <div v-for="field in row.fields" :key="field.label" class="field-row">
                  <span class="field-name">{{ field.label }}</span>
                  <span class="before">{{ field.before }}</span>
                  <el-icon><Right /></el-icon>
                  <span class="after">{{ field.after }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<style scoped>
.head {
  margin-bottom: 12px;
}
.group-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.muted {
  color: #8a8073;
  font-size: 12px;
}
.block {
  margin-bottom: 10px;
}
.block h5 {
  margin: 6px 0;
}
.block ul {
  margin: 0;
  padding-left: 4px;
  list-style: none;
  font-size: 12px;
}
.block li {
  padding: 2px 0;
}
.added {
  color: #1f8a70;
}
.removed {
  color: #c0392b;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
}
.field-name {
  min-width: 86px;
  color: #6b5b45;
}
.before {
  color: #c0392b;
  background: #fbeeed;
  padding: 0 6px;
  border-radius: 4px;
}
.after {
  color: #1f8a70;
  background: #eaf7f3;
  padding: 0 6px;
  border-radius: 4px;
}
:deep(.el-collapse-item__header) {
  font-weight: 600;
}
</style>
