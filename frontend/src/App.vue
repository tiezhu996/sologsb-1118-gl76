<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { onDataChange, useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { sealStore } from '@/stores/sealStore'

const route = useRoute()
const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)
const sealState = useStore(sealStore)

const menus = [
  { path: '/trenches', label: '探方清单', icon: 'Grid' },
  { path: '/strata', label: '地层单位编目', icon: 'Files' },
  { path: '/artifacts', label: '出土物登记', icon: 'Box' },
  { path: '/relations', label: '层位关系', icon: 'Share' },
  { path: '/sections', label: '四壁剖面示意', icon: 'DataLine' },
  { path: '/archive', label: '封存版本', icon: 'FolderOpened' }
]

const activeMenu = computed(() => menus.find((item) => route.path.startsWith(item.path))?.path ?? '/trenches')

const stats = computed(() => [
  { label: '探方', value: trenchState.trenches.length },
  { label: '地层单位', value: stratumState.strata.length },
  { label: '出土物', value: artifactState.artifacts.length },
  { label: '层位关系', value: relationState.relations.length },
  { label: '封存版本', value: sealState.versions.length },
  { label: '复勘草稿', value: sealState.drafts.length }
])

onMounted(async () => {
  // 其他标签页（或本页封存/复勘提交）写入后，自动刷新各实时表，避免双标签页互相覆盖
  let pending: ReturnType<typeof setTimeout> | null = null
  onDataChange(() => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      void sealStore.getState().hydrate()
      void trenchStore.getState().hydrate()
      void stratumStore.getState().hydrate()
      void artifactStore.getState().hydrate()
      void relationStore.getState().hydrate()
    }, 60)
  })
})
</script>

<template>
  <el-container class="shell">
    <el-aside width="232px" class="aside">
      <div class="brand">
        <div class="logo">探</div>
        <div>
          <div class="brand-title">考古探方地层编目台</div>
          <div class="brand-sub">Trench & Stratum Log</div>
        </div>
      </div>
      <el-menu :default-active="activeMenu" router class="menu">
        <el-menu-item v-for="item in menus" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
      <div class="stat-box">
        <div v-for="item in stats" :key="item.label" class="stat-row">
          <span>{{ item.label }}</span>
          <b>{{ item.value }}</b>
        </div>
        <p class="stat-tip">数据保存在浏览器 IndexedDB，无需后端服务</p>
        <p v-if="sealState.drafts.length > 0" class="stat-tip draft-tip">
          <router-link to="/rework">有 {{ sealState.drafts.length }} 份复勘草稿进行中，前往复勘工作台 →</router-link>
        </p>
      </div>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="crumb">{{ (route.meta.title as string) ?? '编目台' }}</span>
        <span class="head-tip">探方 → 地层单位 → 层位关系 → 出土物，层位上下文不丢失</span>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.shell {
  height: 100vh;
}
.aside {
  display: flex;
  flex-direction: column;
  background: #4a3722;
  color: #f4ead9;
  padding: 16px 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}
.logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #e0c168, #a9762f);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: #3c2f1f;
}
.brand-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}
.brand-sub {
  font-size: 11px;
  color: #cbb99f;
}
.menu {
  border-right: none;
  background: transparent;
}
:deep(.menu .el-menu-item) {
  color: #ecdfcb;
  border-radius: 8px;
  margin-bottom: 4px;
}
:deep(.menu .el-menu-item.is-active) {
  background: #a9762f;
  color: #fff;
}
:deep(.menu .el-menu-item:hover) {
  background: #5c452b;
}
.stat-box {
  margin-top: auto;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 12px;
}
.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  color: #ecdfcb;
}
.stat-tip {
  margin: 8px 0 0;
  color: #bfae95;
  line-height: 1.6;
}
.draft-tip {
  color: #e0c168;
}
.draft-tip a {
  color: #e0c168;
  text-decoration: none;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e6ded0;
}
.crumb {
  font-weight: 600;
}
.head-tip {
  font-size: 12px;
  color: #8a8073;
}
.main {
  padding: 0;
  overflow: auto;
}
</style>
