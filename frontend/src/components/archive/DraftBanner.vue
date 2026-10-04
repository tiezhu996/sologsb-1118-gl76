<script setup lang="ts">
import { computed } from 'vue'
import type { SurveyDraft } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { archiveStore } from '@/stores/archiveStore'

const props = defineProps<{ trenchId?: string }>()

const emit = defineEmits<{
  (event: 'submit', draft: SurveyDraft): void
  (event: 'discard', draft: SurveyDraft): void
}>()

const archiveState = useStore(archiveStore)

const drafts = computed(() =>
  props.trenchId
    ? archiveState.drafts.filter((item) => item.trenchId === props.trenchId && item.status === 'open')
    : archiveState.drafts.filter((item) => item.status === 'open')
)
</script>

<template>
  <el-alert
    v-for="draft in drafts"
    :key="draft.id"
    class="draft-banner"
    type="warning"
    :closable="false"
    show-icon
  >
    <template #title>
      复勘草稿进行中（基于封存 v{{ draft.baseVersionNo }}，最近修改
      {{ draft.updatedAt.slice(0, 16).replace('T', ' ') }}）——当前编辑只写入草稿，封存版不受影响
    </template>
    <template #default>
      <el-button size="small" type="primary" @click="emit('submit', draft)">提交封存新版本</el-button>
      <el-button size="small" plain @click="emit('discard', draft)">放弃草稿</el-button>
    </template>
  </el-alert>
</template>

<style scoped>
.draft-banner {
  margin-bottom: 12px;
}
</style>
