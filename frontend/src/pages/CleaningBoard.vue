<script setup lang="ts">
/**
 * /cleaning 罐位清洗放行台：
 * 出罐后的罐位在此按「碱洗 → 消毒 → 冲洗」顺序记录清洗值，三步合格自动放行；
 * 更正任一步骤的清洗值，后续步骤立即失效并留痕；放行单被入罐占用后锁定。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, RefreshLeft } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import CleaningTimeline from '@/components/common/CleaningTimeline.vue'
import { db, type BatchRow, type CleaningRow, type ParcelRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useCleaningStore } from '@/stores/cleaningStore'
import { TANK_MATERIALS, TANK_STATES } from '@/types/tank'
import type { CleaningStepKind } from '@/types/cleaning'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useCleaningStore()

const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: cleanings } = useIdbTable<CleaningRow>(() => db.cleanings, {
  compare: (a, b) => b.updatedAt - a.updatedAt
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches, {
  compare: (a, b) => b.harvestDate.localeCompare(a.harvestDate)
})
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)

const selects: FilterSelectConfig[] = [
  { key: 'states', label: '罐位', options: TANK_STATES.map((item) => ({ label: item, value: item })) },
  { key: 'materials', label: '材质', options: TANK_MATERIALS.map((item) => ({ label: item, value: item })) }
]

/** 每个罐位的最新放行单 */
const latestReleaseMap = computed(() => {
  const map = new Map<string, CleaningRow>()
  for (const row of cleanings.value) {
    const existing = map.get(row.tankId)
    if (!existing || row.updatedAt > existing.updatedAt) map.set(row.tankId, row)
  }
  return map
})

function latestRelease(tankId: string): CleaningRow | null {
  return latestReleaseMap.value.get(tankId) ?? null
}

function batchLabelOf(batchId: string | null): string {
  if (!batchId) return '—'
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return `批次 ${batchId}`
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.harvestDate} · ${batch.volumeL}L`
}

const filteredTanks = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  const materials = Array.isArray(store.filters.materials) ? store.filters.materials : []
  return tanks.value.filter((tank) => {
    if (keyword && !`${tank.code} ${tank.material}`.toLowerCase().includes(keyword)) return false
    if (states.length > 0 && !states.includes(tank.state)) return false
    if (materials.length > 0 && !materials.includes(tank.material)) return false
    return true
  })
})

const totals = computed(() => ({
  total: tanks.value.length,
  dirty: tanks.value.filter((tank) => tank.state === '待清洗').length,
  washing: tanks.value.filter((tank) => tank.state === '清洗中').length,
  released: tanks.value.filter((tank) => tank.state === '空闲').length,
  occupied: tanks.value.filter((tank) => tank.state === '在用').length
}))

const currentTank = computed<TankRow | null>(
  () => tanks.value.find((tank) => tank.id === store.selectedTankId) ?? null
)
const currentRelease = computed<CleaningRow | null>(() =>
  currentTank.value ? latestRelease(currentTank.value.id) : null
)

/** 该罐历史放行单（旧到新），用于追溯 */
const releaseHistory = computed(() =>
  currentTank.value
    ? cleanings.value
        .filter((item) => item.tankId === currentTank.value?.id)
        .sort((a, b) => a.createdAt - b.createdAt)
    : []
)

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 16)
}

async function handleRecord(payload: { kind: CleaningStepKind; value: number; operator: string }): Promise<void> {
  if (!currentRelease.value) return
  try {
    await store.recordStep(currentRelease.value.id, payload.kind, payload.value, payload.operator)
    ElMessage.success(`${payload.kind}清洗值已记录`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '记录失败')
  }
}

async function restartWashing(): Promise<void> {
  if (!currentTank.value) return
  try {
    await ElMessageBox.confirm(
      `对罐 ${currentTank.value.code} 重新发起清洗？当前已放行单将作废留痕，罐位回到「待清洗」。`,
      '重新清洗确认',
      { type: 'warning', confirmButtonText: '确认重新清洗' }
    )
  } catch {
    return
  }
  try {
    await store.restart(currentTank.value.id)
    ElMessage.success('已开启新的清洗放行单')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

const historyPanel = ref(false)

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
  if (!store.selectedTankId && filteredTanks.value.length > 0) {
    // 默认展示第一口非在用罐，方便班组直接录清洗
    const first = filteredTanks.value.find((tank) => tank.state !== '在用') ?? filteredTanks.value[0]
    store.selectTank(first.id)
  }
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(
  () => store.selectedTankId,
  (tankId) => {
    historyPanel.value = false
    if (tankId) {
      void router.replace({ path: route.path, query: { ...filtersToQuery(store.filters), tankId } })
    }
  }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">罐位清洗放行台</h2>
        <p class="page__subtitle">
          出罐罐位按 <strong>碱洗 → 消毒 → 冲洗</strong> 顺序记录，三步合格才放行；更正清洗值后，后续步骤立即失效并留痕。
        </p>
      </div>
      <div>
        <el-button :icon="ArrowLeft" @click="router.push(ROUTES.tanks)">返回罐位看板</el-button>
        <el-button type="primary" @click="router.push(ROUTES.batches)">去入罐登记</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐位总数" :value="totals.total" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="待清洗" :value="totals.dirty" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge label="清洗中" :value="totals.washing" suffix="个" icon="Histogram" tone="warning" />
      <StatBadge label="已放行" :value="totals.released" suffix="个" icon="Files" tone="success" />
      <StatBadge label="在用" :value="totals.occupied" suffix="个" icon="DataLine" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索罐号 / 材质…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-row :gutter="16" class="layout">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>罐位清单（{{ filteredTanks.length }}）</span>
              <span class="muted">出罐后自动进入待清洗</span>
            </div>
          </template>
          <EmptyPanel
            v-if="filteredTanks.length === 0"
            title="没有匹配的罐位"
            description="调整罐位 / 材质筛选条件。"
            :show-create="false"
          />
          <div v-else class="tank-list">
            <div
              v-for="tank in filteredTanks"
              :key="tank.id"
              class="tank-item"
              :class="{ 'is-active': tank.id === store.selectedTankId }"
              @click="store.selectTank(tank.id)"
            >
              <div class="tank-item__head">
                <span class="tank-item__code">{{ tank.code }}</span>
                <StageTag :value="tank.state" size="small" />
              </div>
              <div class="tank-item__meta">{{ tank.material }} · {{ tank.capacityL }}L · {{ tank.tempControl }}</div>
              <div class="tank-item__release">
                <template v-if="latestRelease(tank.id)?.state === '已占用'">
                  已被 {{ batchLabelOf(latestRelease(tank.id)?.occupiedByBatchId ?? null) }} 占用
                </template>
                <template v-else-if="tank.state === '空闲'">已放行，可分配新批次</template>
                <template v-else-if="tank.state === '清洗中'">放行单进行中，继续完成剩余步骤</template>
                <template v-else>待清洗：等待碱洗开始</template>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card v-if="currentTank" shadow="never">
          <template #header>
            <div class="card-title">
              <span>罐 {{ currentTank.code }} · 清洗放行单</span>
              <div>
                <el-button
                  v-if="currentTank.state === '空闲'"
                  size="small"
                  :icon="RefreshLeft"
                  plain
                  type="warning"
                  @click="restartWashing"
                >
                  重新清洗
                </el-button>
                <el-button size="small" text type="primary" @click="historyPanel = !historyPanel">
                  {{ historyPanel ? '收起追溯链' : '查看追溯链' }}
                </el-button>
              </div>
            </div>
          </template>

          <el-descriptions :column="2" border size="small" class="desc">
            <el-descriptions-item label="罐位状态"><StageTag :value="currentTank.state" size="small" /></el-descriptions-item>
            <el-descriptions-item label="材质 / 容量">
              {{ currentTank.material }} · {{ currentTank.capacityL }}L · {{ currentTank.tempControl }}
            </el-descriptions-item>
            <el-descriptions-item label="上一批次（出罐触发）">
              {{ batchLabelOf(currentRelease?.fromBatchId ?? null) }}
            </el-descriptions-item>
            <el-descriptions-item label="放行 / 占用">
              放行 {{ formatTime(currentRelease?.releasedAt ?? null) }} ｜ 入罐占用
              {{ formatTime(currentRelease?.occupiedAt ?? null) }}
            </el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="currentRelease?.note"
            class="desc"
            type="warning"
            :closable="false"
            show-icon
            :title="currentRelease.note"
          />

          <CleaningTimeline :release="currentRelease" @record="handleRecord" />

          <el-divider v-if="historyPanel" content-position="left">追溯链：出罐 → 清洗 → 入罐</el-divider>
          <el-timeline v-if="historyPanel" class="history">
            <el-timeline-item
              v-for="release in releaseHistory"
              :key="release.id"
              :timestamp="`单据 ${release.id}`"
              :type="release.state === '已占用' ? 'success' : release.state === '已放行' ? 'primary' : 'warning'"
            >
              <div class="history__title">
                {{ release.state }}
                <span class="muted">
                  上一批次 {{ batchLabelOf(release.fromBatchId) }} → 入罐 {{ batchLabelOf(release.occupiedByBatchId) }}
                </span>
              </div>
              <div v-for="step in release.steps" :key="`${step.kind}-${step.recordedAt}`" class="history__step">
                <el-tag
                  size="small"
                  :type="step.state === '合格' ? 'success' : step.state === '不合格' ? 'danger' : 'info'"
                  effect="plain"
                >
                  {{ step.kind }} {{ step.state }}
                </el-tag>
                <span>{{ step.value ?? '—' }} · {{ step.operator }} · {{ formatTime(step.recordedAt) }}</span>
              </div>
            </el-timeline-item>
          </el-timeline>
        </el-card>

        <el-card v-else shadow="never">
          <EmptyPanel title="未选择罐位" description="在左侧选择一口罐后查看清洗放行单。" :show-create="false" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.layout {
  margin-top: 14px;
}

.tank-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 640px;
  overflow-y: auto;
}

.tank-item {
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.tank-item.is-active {
  border-color: #b9688a;
  background: #fdf3f6;
}

.tank-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tank-item__code {
  font-weight: 600;
}

.tank-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.tank-item__release {
  margin-top: 4px;
  font-size: 12px;
  color: #6b6257;
}

.desc {
  margin-bottom: 14px;
}

.history__title {
  font-weight: 600;
  margin-bottom: 6px;
}

.history__step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b6257;
  line-height: 2;
}
</style>
