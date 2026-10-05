# 葡萄酒发酵罐与倒罐批次台（gbwinetank）

面向酒庄酿酒师与发酵车间班组的本地化车间台账：按地块采收把葡萄入罐发酵，逐日记录比重、温度与糖度，编排倒罐、压帽与淋皮作业，跟踪苹果酸乳酸发酵进度，并在出罐前完成品评与调配结论。

核心动作：**建地块与品种 → 配置发酵罐容量 → 录发酵读数 → 排作业工序 → 启动苹乳发酵 → 录品评并导出批次档案**。

罐位卫生链路：**出罐 → 罐位「待清洗」→ 碱洗 / 消毒 / 冲洗 按顺序记录 → 三步达标「放行」→ 入罐消费放行**。清洗值一经更正，后续步骤立即失效并撤销已放行状态；入罐在单个事务内完成校验与占用，两个标签页同时提交只有一方成功，另一方保留草稿并看到失效步骤；批次档案可追溯入罐时的清洗放行记录。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22826**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbwinetank}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库 JSON / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、进度条、时间线交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22826 |
| 状态管理 | Pinia（setup store） | `parcelStore` / `tankStore` / `batchStore` / `operationStore` / `mlfStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbwinetank-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22826
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22826）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/parcels` | 地块与品种台账 | Parcel、Batch | 新建/编辑/删除地块、按品种与朝向筛选、回显在罐批次数与累计入罐量、筛选同步 URL query |
| `/tanks` | 发酵罐容量配置与罐位看板 | Tank、Batch、CleaningRecord | 按材质/温控/罐位筛选、罐位占用冲突校验、清洗三步记录与放行、更正后后续步骤失效 |
| `/batches` | 入罐登记与发酵读数 | Batch、Reading、Parcel、Tank、CleaningRecord | 凭清洗放行入罐（事务内占用，冲突方保留草稿并提示失效步骤）、逐日录比重/温度/糖度、趋势条、超温标记、出罐转待清洗 |
| `/operations` | 倒罐与压帽作业编排 | Operation、Batch | 按日期排班、拖拽调序（含上下移按钮）、指派操作人、完成回写批次最近作业时间 |
| `/mlf` | 苹果酸乳酸发酵跟踪 | Mlf、Batch、Reading | 启动苹乳、逐次录入苹果酸、低于阈值自动判定结束并联动批次状态 |
| `/tasting` | 品评调配与批次档案 | Tasting 及全部模型 | 同批次多次品评并列对比、批次档案 JSON 导出、本地库版本查看与整库导入导出 |

---

## 五、目录结构

```
sologsb101-1026/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # parcel.ts tank.ts batch.ts reading.ts operation.ts mlf.ts tasting.ts cleaning.ts filter.ts
        ├── stores/             # parcelStore tankStore batchStore operationStore mlfStore
        ├── components/common/  # StageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useFermentTrend.ts useIdbTable.ts
        ├── utils/              # gravity.ts db.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # ParcelList TankBoard BatchReading OperationPlan MlfBoard TastingExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbwinetank-db`（Dexie 封装），当前结构版本 `version(2)`，带 `upgrade()` 迁移逻辑。
- **分表存储**：`parcels` 地块、`tanks` 发酵罐、`batches` 入罐批次、`readings` 发酵读数、`operations` 作业、`mlfs` 苹乳发酵、`tastings` 品评调配、`cleanings` 清洗放行，共 8 张表；每行带 `revision` / `createdAt` / `updatedAt`。
- **清洗放行链路**：`cleanings` 记录某罐一次「出罐 → 清洗 → 放行 → 入罐」全过程：`fromBatchId`（触发清洗的出罐批次）、三步实测值（碱液浓度 / 消毒剂浓度 / 冲洗水 pH，各带达标区间）、`releasedAt`、`toBatchId`（消费放行的入罐批次）。更正任一清洗值会使后续步骤立即失效并撤销放行；已消费的记录归档锁定、禁止再改。批次经 `cleaningId` 引用入罐时的放行记录，批次档案（导出 JSON）内含完整清洗步骤与 `cleaningPassed` 结论。
- **罐位状态机**：`在用 →（出罐）→ 待清洗 →（记录步骤）→ 清洗中 →（三步达标放行）→ 空闲 →（入罐）→ 在用`，状态只能由流程动作驱动，不允许手工直接改写；只有「空闲」（即清洗已放行）的罐位可被分配。
- **并发占用**：入罐 / 改绑在单个 Dexie 事务内完成「校验放行 → 建批次 → 消费放行 → 罐位置在用」，依赖 IndexedDB 事务串行化，两个标签页同时提交同一罐位时只有一方成功，另一方收到含失效步骤的错误并保留表单草稿。
- **v1 → v2 迁移**：旧库升级时，批次补 `cleaningId = null`；所有非「在用」罐位因缺放行记录一律转入「待清洗」，并各补一条空清洗记录等待班组逐步录入。导入 v1 旧备份时走同一规则。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `parcels` 表为空时调用 `seedDatabase()`，灌入互相引用的演示数据（含已放行 / 冲洗未达标 / 已消费等清洗形态），保证每个页面首次打开都有内容；播种幂等，清空后重进会重新播种。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **数据迁移**：在「品评与批次档案」页可导出整库 JSON 备份，或导出单批次档案；在其它设备用「导入备份」还原。
- **级联规则**：删除地块会级联删除其下批次与批次的读数/作业/苹乳/品评，占用中的罐位转「待清洗」并生成新清洗记录；在罐批次不允许删除发酵罐，删除发酵罐会一并删除其清洗放行记录。
