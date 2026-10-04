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
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

> **回填封存与复勘（v3）**：探方回填确认不再是一个可随意切换的标记，而是一次**封存动作**——把探方、地层单位、出土物、层位关系冻结成只读的「封存版本」。封存后所有编目页默认只读；改正必须从封存版开启**复勘草稿**，在草稿工作副本里修改，比对差异后提交，生成新版本。旧版本永久保留、可查看导出。两个标签页并发提交时，后提交的一方会收到「基底已过期」提示，草稿保留，比对变基后重交。

## 三、本地开发

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
│       ├── types/              # trench.ts / stratum.ts / artifact.ts / relation.ts / seal.ts / index.ts
│       ├── stores/             # trench / stratum / artifact / relation / seal（Zustand，封存守卫在实体 store）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker / SnapshotDiffViewer
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore（Dexie + 跨标签页通知）
│       ├── pages/              # Trenches / Strata / Artifacts / Relations / Sections / Archive / Rework
│       ├── router/index.ts
│       └── utils/              # graph.ts / export.ts / id.ts / snapshot.ts / diff.ts / errors.ts / archiveExport.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点坐标、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | 所属地层单位、器物编号、类别、件数、残整程度、探方内 X/Y/Z、出土日期、提取人、临时存放 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |
| SealedVersion 封存版本 | 版本号（按探方从 1 递增）、封存时间/确认人/说明、冻结的探方+地层+出土物+关系完整快照 | `sealedVersions` |
| ReworkDraft 复勘草稿 | 依据的基底封存版本号、创建人/事由、创建与更新时间、可修改的工作副本快照 | `reworkDrafts` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 升级新增封存/草稿表，并**自动为所有已回填的历史探方补封第一版**（封存时间标记为系统升级时间、确认人记为「系统补封」），快照口径与回填封存一致；
- 跨标签页通过 `BroadcastChannel('gbtrenchlog-data-v3')` 广播数据变更，其他标签页自动刷新实时表，避免在过期数据上继续编辑；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态；「回填确认并封存」生成第一版封存 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮；已封存探方的记录只读并标注封存标记 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度；封存探方的出土物只读 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测；封存探方的关系只读 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |
| `/archive` | 封存版本档案：按探方查看各版本时间线，任一历史版本的探方/地层/出土物/关系快照都可查看并导出 JSON 与 CSV |
| `/rework` | 复勘工作台：从封存版 fork 的草稿中改正四类记录，实时校验单位号/层序/环路/深度；提交前展示差异比对，提交生成新版本 |

## 七、回填封存与复勘工作流

1. **回填确认 = 封存第一版**：在探方卡片点击「回填确认并封存」，系统在一个 Dexie 事务内把探方（置为已回填）、该探方全部地层单位、出土物、层位关系冻结成快照，写入 `sealedVersions`（版本号 1）。封存后实体只读，普通编目页的新增/编辑/删除/批量操作在 store 层即被 `TrenchFrozenError` 拦截，页面同步禁用入口。
2. **要改正就开复勘草稿**：封存探方的卡片提供「复勘修正」，从最新封存版 clone 一份工作副本到 `reworkDrafts`；实时档案保持只读，草稿改动不影响当前封存版。
3. **工作台四类改正 + 差异比对**：在 `/rework` 修改探方信息、地层单位、出土物、层位关系（仍执行单位号唯一、层序倒置、出土深度、环路等校验）。提交前在差异面板查看新增/删除/修改，确认后在事务内核验并整组替换实时表，生成新版本（版本号 +1），旧版与草稿历史不受影响。
4. **双标签页并发（乐观并发控制）**：提交时在同一读写事务内读取最新封存版本，若草稿基底版本号与最新版本不一致（其他标签页已提交），抛 `BaseStaleError`：**本次写入整体回滚、草稿原样保留**；工作台出现红色「基底已过期」横幅与「与最新版比对」，记录员核对最新版改动后「变基到最新版」（仅更新基底号，草稿内容保留）再重新提交。
5. **历史版本可查可导**：`/archive` 按探方列出全部版本时间线，任一版本的完整快照可导出 JSON 或按地层单位/出土物/层位关系分别导出 CSV，历史导出结果不会被后续改正覆盖。
6. **旧数据升级**：已在使用中的库升级到 v3 时，迁移事务扫描所有 `backfilled=true` 的探方，按当前表数据补封第 1 版（说明为「旧数据升级：为已回填探方补封第一版封存」），使回填档案具备可复勘、可追溯的版本链。

## 九、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。
