# 考古探方地层编目台（gbtrenchlog）

面向考古发掘工地的记录员与整理人员，把「探方 → 地层单位 → 堆积描述 → 层位关系 → 出土物」整理成一套可核对的编目档案，解决地层编号重复、打破与叠压关系记不清、出土物脱离层位上下文的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21818>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbtrenchlog
FRONTEND_PORT=21818
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21818
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1118/
├── docker-compose.yml          # 顶层 name: gbtrenchlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # trench.ts / stratum.ts / artifact.ts / relation.ts / index.ts
│       ├── stores/             # trenchStore / stratumStore / artifactStore / relationStore（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore
│       ├── pages/              # TrenchesPage / StrataPage / ArtifactsPage / RelationsPage / SectionsPage
│       ├── router/index.ts
│       └── utils/              # graph.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点坐标、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | 所属地层单位、器物编号、类别、件数、残整程度、探方内 X/Y/Z、出土日期、提取人、临时存放 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |
| ArchiveVersion 封存版本 | 探方、版本号、父版本、封存时的探方副本、说明、时间 | `archiveVersions` |
| 封存快照行 | 地层/出土物/关系的不可变副本，复合主键 `版本id:原id` + `originId` 跨版身份 | `archiveStrata/Artifacts/Relations` |
| SurveyDraft 复勘草稿 | 探方、基底版本（乐观锁）、状态、工作区四实体副本 | `drafts` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 起支持回填封存版本体系（见下节），升级时自动为**已回填但无封存**的探方补第一版封存；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 五之二、回填封存版本（archive）

回填确认不再是打一个可随意切换的标记，而是生成**不可变的封存版本**：

- **封存即冻结**：一次封存完整冻结「探方 + 该探方全部地层单位 + 出土物 + 层位关系」（关系任一端单位属于本探方即纳入），存入独立的 `archiveVersions / archiveStrata / archiveArtifacts / archiveRelations` 快照表；
- **默认只读**：有封存版本、且无进行中复勘草稿的探方，在探方/地层/出土物/关系各页面一律只读（编辑表单禁用、删除拦截），不会再出现「直接改把原编目和历史导出一起改掉」；
- **复勘草稿**：从任一封存版本「开复勘草稿」，克隆出版本工作区，改动只写入 `drafts` 表，封存版原样保留；每探方同时只允许一个打开的草稿；
- **乐观锁提交**：提交时在单个 IndexedDB 事务内比对「草稿基底版本是否仍是该探方最新封存版」。两个标签页同时提交时，后提交的一份收到 `StaleBaseError`：**草稿保留**、弹出「基底 / 最新版 / 草稿」三方比对（字段级标出双方都改过的冲突），可一键「并入最新版改动后重交」（rebase：仅对方改动自动并入，冲突字段保留草稿值供回页面核对）；
- **新版本链**：提交成功生成递增的新版本（`parentId` 指向基底），现行数据替换为草稿内容；**所有旧版本永久可查看、可导出**（整版 JSON + 地层/出土物/关系 CSV）；
- **历史数据升级**：v3 迁移在升级事务内扫描已回填探方，对无封存者补 `v1`（说明标注「数据升级补封」），示例数据中的回填探方也自带第一版封存。

| 相关模块 | 位置 |
| --- | --- |
| 类型 | `src/types/archive.ts`（`ArchiveVersion / ArchiveStratum/Artifact/Relation / SurveyDraft`） |
| 封存服务 | `src/services/archiveService.ts`（`sealTrench / openDraft / commitDraft / rebaseDraft / getVersion`） |
| 三方比对与 rebase | `src/utils/diff.ts` |
| 只读门面 | `src/hooks/useCatalog.ts`（各页面统一走门面，封存只读、草稿覆盖现行视图） |
| 草稿工作区写操作 | `src/stores/archiveStore.ts` |
| 跨标签页事件 | `src/hooks/useArchiveEvents.ts`（BroadcastChannel + storage） |
| UI | `src/components/archive/`（`ArchiveDrawer` 版本查看/导出、`DraftBanner`、`CommitDraftDialog` 冲突比对） |
| 逻辑验证 | `npm run verify:archive`（fake-indexeddb 跑通封存/并发冲突/rebase/升级补封，29 项断言） |

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮，深度刻度条展示厚度 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度是否在该区间内 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。
