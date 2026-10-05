<script setup lang="ts">
/** /tanks 发酵罐容量配置与罐位状态看板：状态由清洗放行链派生，按材质 / 温控筛选 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import {
  db,
  TankGateError,
  type BatchRow,
  type CleaningRow,
  type ParcelRow,
  type TankRow
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import {
  TANK_MATERIALS,
  TANK_STATES,
  TANK_TEMP_CONTROLS,
  createEmptyTank,
  type Tank
} from '@/types/tank'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useTankStore()

const { rows: tanks, ready } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: parcels } = useIdbTable<ParcelRow>(() => db.parcels)
const { rows: cleanings } = useIdbTable<CleaningRow>(() => db.cleanings, {
  compare: (a, b) => b.updatedAt - a.updatedAt
})

const selects: FilterSelectConfig[] = [
  { key: 'materials', label: '材质', options: TANK_MATERIALS.map((item) => ({ label: item, value: item })) },
  { key: 'tempControls', label: '温控', options: TANK_TEMP_CONTROLS.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '罐位', options: TANK_STATES.map((item) => ({ label: item, value: item })) }
]

/** 占用该罐的在罐批次 */
function occupancyOf(tankId: string): BatchRow | null {
  return store.occupancyOf(tankId, batches.value)
}

function batchLabel(batch: BatchRow | null): string {
  if (!batch) return '—'
  const parcel = parcels.value.find((item) => item.id === batch.parcelId)
  return `${parcel ? parcel.name : '未知地块'} · ${batch.volumeL}L`
}

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

function releaseHint(tank: TankRow): string {
  const release = latestRelease(tank.id)
  switch (tank.state) {
    case '在用':
      return `已被入罐批次占用${release?.releasedAt ? `（放行于 ${release.releasedAt.slice(0, 10)}）` : ''}`
    case '空闲':
      return '清洗已放行，可分配新批次'
    case '清洗中':
      return '清洗放行未完成，不可分配'
    case '待清洗':
    default:
      return release?.note?.includes('旧数据升级')
        ? '旧数据升级：缺放行记录，待重新清洗'
        : '出罐待清洗，完成碱洗/消毒/冲洗后才放行'
  }
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const materials = Array.isArray(store.filters.materials) ? store.filters.materials : []
  const tempControls = Array.isArray(store.filters.tempControls) ? store.filters.tempControls : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return tanks.value.filter((tank) => {
    const label = `${tank.code} ${tank.material} ${tank.tempControl} ${tank.state}`
    if (keyword && !label.toLowerCase().includes(keyword)) return false
    if (materials.length > 0 && !materials.includes(tank.material)) return false
    if (tempControls.length > 0 && !tempControls.includes(tank.tempControl)) return false
    if (states.length > 0 && !states.includes(tank.state)) return false
    return true
  })
})

const totals = computed(() => {
  const totalCapacity = tanks.value.reduce((sum, tank) => sum + tank.capacityL, 0)
  const usedCapacity = tanks.value
    .filter((tank) => occupancyOf(tank.id) !== null)
    .reduce((sum, tank) => sum + tank.capacityL, 0)
  return {
    tankCount: tanks.value.length,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length,
    dirtyCount: tanks.value.filter((tank) => tank.state === '待清洗' || tank.state === '清洗中').length,
    totalCapacity,
    usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tank, 'id' | 'state'>>(baseForm())

function baseForm(): Omit<Tank, 'id' | 'state'> {
  const { code, material, capacityL, tempControl } = createEmptyTank()
  return { code, material, capacityL, tempControl }
}

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, baseForm())
  dialogVisible.value = true
}

function openEdit(tank: TankRow): void {
  editingId.value = tank.id
  Object.assign(form, {
    code: tank.code,
    material: tank.material,
    capacityL: tank.capacityL,
    tempControl: tank.tempControl
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateTank(editingId.value, { ...form })
    ElMessage.success('罐位配置已更新（罐位状态由清洗放行流程决定）')
  } else {
    await store.createTank({ ...form })
    ElMessage.success('发酵罐已建档，罐位初始为「待清洗」')
  }
  dialogVisible.value = false
}

async function remove(tank: TankRow): Promise<void> {
  const occupied = occupancyOf(tank.id)
  if (occupied) {
    ElMessage.warning(`罐 ${tank.code} 正被批次占用，请先出罐或改绑其它罐位`)
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除发酵罐「${tank.code}」？其清洗放行记录将一并删除。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除'
    })
  } catch {
    return
  }
  await store.deleteTank(tank.id)
  ElMessage.success('发酵罐已删除')
}

/** 为该罐分配一个在罐批次（事务内校验清洗放行门槛与并发占用） */
async function assignBatch(tank: TankRow): Promise<void> {
  const candidates = batches.value.filter((batch) => batch.state !== '已出罐' && batch.tankId !== tank.id)
  if (candidates.length === 0) {
    ElMessage.info('暂无待分配的在罐批次')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt(
      `可分配批次：\n${candidates.map((batch) => `${batch.id}（${batchLabel(batch)}）`).join('\n')}`,
      `为罐 ${tank.code} 分配批次（需已完成清洗放行）`,
      { inputPlaceholder: '粘贴批次 id', confirmButtonText: '分配', cancelButtonText: '取消' }
    )
    const picked = candidates.find((batch) => batch.id === value.trim())
    if (!picked) {
      ElMessage.error('批次 id 不存在，请重新选择')
      return
    }
    await store.assign(tank.id, picked.id)
    ElMessage.success('罐位已占用，清洗放行单随批次归档')
  } catch (error) {
    if (error instanceof TankGateError) {
      ElMessage.error(
        error.failedSteps.length > 0
          ? `罐 ${tank.code} 清洗未达标：${error.failedSteps.join('、')}，请先到清洗放行台补录`
          : error.message
      )
    } else if (error instanceof Error && error.message) {
      ElMessage.warning(error.message)
    }
  }
}

function gotoCleaning(tank: TankRow): void {
  void router.push({ path: ROUTES.cleaning, query: { tankId: tank.id } })
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">发酵罐容量配置与罐位看板</h2>
        <p class="page__subtitle">
          罐位随「出罐 → 清洗放行 → 入罐」自动流转：出罐即待清洗，三步合格放行后才能分配新批次。
        </p>
      </div>
      <div>
        <el-button type="success" plain @click="router.push(ROUTES.cleaning)">去清洗放行台</el-button>
        <el-button @click="router.push(ROUTES.batches)">去入罐登记</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增发酵罐</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐总数" :value="totals.tankCount" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="已放行可入罐" :value="totals.freeCount" suffix="个" icon="Files" tone="success" />
      <StatBadge label="待清洗/清洗中" :value="totals.dirtyCount" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge label="已占用容量" :value="totals.usedCapacity" suffix="L" icon="DataLine" tone="warning" />
      <StatBadge label="罐容利用率" :value="totals.usageRatio" :percent="totals.usageRatio" show-percent tone="danger" icon="PieChart" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索罐号 / 材质 / 温控…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-title">
          <span>罐位清单（{{ filtered.length }} / {{ tanks.length }}）</span>
          <span class="muted">未完成清洗放行的罐位不能分配给新批次</span>
        </div>
      </template>

      <EmptyPanel
        v-if="ready && filtered.length === 0"
        title="没有匹配的发酵罐"
        description="新增一个发酵罐，或调整材质 / 温控 / 罐位筛选。"
        create-text="新增发酵罐"
        @create="openCreate"
      />

      <el-table v-else :data="filtered" stripe border>
        <el-table-column prop="code" label="罐号" width="100" />
        <el-table-column prop="material" label="材质" width="90" />
        <el-table-column prop="capacityL" label="容量(L)" width="100" align="right" />
        <el-table-column prop="tempControl" label="温控" width="90" />
        <el-table-column label="罐位状态" width="110">
          <template #default="{ row }">
            <StageTag :value="row.state" />
          </template>
        </el-table-column>
        <el-table-column label="清洗放行" min-width="230">
          <template #default="{ row }">
            <div class="release-cell">
              <span>{{ releaseHint(row) }}</span>
              <el-button link type="primary" size="small" @click="gotoCleaning(row)">查看 / 录入清洗</el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="占用批次" min-width="180">
          <template #default="{ row }">
            <span v-if="occupancyOf(row.id)">{{ batchLabel(occupancyOf(row.id)) }}</span>
            <span v-else class="muted">未占用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.state !== '空闲'" @click="assignBatch(row)">分配批次</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑发酵罐' : '新增发酵罐'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="罐号" prop="code">
          <el-input v-model="form.code" placeholder="如：F-05" />
        </el-form-item>
        <el-form-item label="材质">
          <el-radio-group v-model="form.material">
            <el-radio-button v-for="item in TANK_MATERIALS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="容量(L)" prop="capacityL">
          <el-input-number v-model="form.capacityL" :min="50" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="温控方式">
          <el-select v-model="form.tempControl" class="full">
            <el-option v-for="item in TANK_TEMP_CONTROLS" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-form-item label="罐位状态">
          <el-tag type="danger" effect="plain">新罐默认「待清洗」</el-tag>
          <span class="muted state-tip">状态由清洗放行流程自动流转，不可手工修改</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.release-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  font-size: 13px;
}

.state-tip {
  margin-left: 8px;
  font-size: 12px;
}
</style>
