<script setup lang="ts">
/** /tanks 发酵罐容量配置与罐位状态看板：罐位状态由 出罐 → 待清洗 → 清洗三步 → 放行 → 入罐 流程驱动 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StageTag from '@/components/common/StageTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type CleaningRow, type ParcelRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTankStore } from '@/stores/tankStore'
import { TANK_MATERIALS, TANK_STATES, TANK_TEMP_CONTROLS, createEmptyTank, type Tank } from '@/types/tank'
import {
  CLEANING_STEP_RULES,
  CLEANING_STEPS,
  cleaningGaps,
  cleaningReleasable,
  isStepValid,
  stepOf,
  type CleaningStepName
} from '@/types/cleaning'
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
const { rows: cleanings } = useIdbTable<CleaningRow>(() => db.cleanings)

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

/** 该罐最新一条清洗放行记录 */
function latestCleaning(tankId: string): CleaningRow | null {
  const rows = cleanings.value.filter((item) => item.tankId === tankId)
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
}

/** 有效步骤数（已记录且未失效） */
function validStepCount(record: CleaningRow): number {
  return CLEANING_STEPS.filter((name) => isStepValid(stepOf(record, name))).length
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
    totalCapacity,
    usedCapacity,
    usageRatio: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 100) : 0,
    freeCount: tanks.value.filter((tank) => tank.state === '空闲').length,
    pendingCount: tanks.value.filter((tank) => tank.state === '待清洗' || tank.state === '清洗中').length
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Tank, 'id' | 'state'>>(createEmptyTank())

const rules: FormRules = {
  code: [{ required: true, message: '请填写罐号', trigger: 'blur' }],
  capacityL: [{ required: true, message: '请填写容量', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyTank())
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
    ElMessage.success('罐位配置已更新')
  } else {
    await store.createTank({ ...form })
    ElMessage.success('发酵罐已建档，罐位「待清洗」，完成三步清洗放行后可分配')
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

/* ------------------------------ 清洗放行 ------------------------------ */
const cleaningDialog = ref(false)
const cleaningTankId = ref<string | null>(null)
const operator = ref('')
const stepInputs = reactive<Record<CleaningStepName, number>>({ 碱洗: 2, 消毒: 100, 冲洗: 7 })

const cleaningTank = computed<TankRow | null>(
  () => tanks.value.find((tank) => tank.id === cleaningTankId.value) ?? null
)

const cleaningRecord = computed<CleaningRow | null>(() =>
  cleaningTankId.value ? latestCleaning(cleaningTankId.value) : null
)

const gaps = computed(() => cleaningGaps(cleaningRecord.value))
const releasable = computed(() => (cleaningRecord.value ? cleaningReleasable(cleaningRecord.value) : false))

/** 步骤展示状态：未记录 / 已失效 / 已达标 / 未达标 */
function stepStatus(record: CleaningRow, name: CleaningStepName): string {
  const step = stepOf(record, name)
  if (!step) return '未记录'
  if (step.invalidated) return '已失效'
  return step.passed ? '已达标' : '未达标'
}

/** 该步是否可记录 / 更正：记录未被消费，且前序步骤全部有效 */
function canRecord(record: CleaningRow, name: CleaningStepName): boolean {
  if (record.state === '已消费') return false
  const index = CLEANING_STEPS.indexOf(name)
  return CLEANING_STEPS.slice(0, index).every((prev) => isStepValid(stepOf(record, prev)))
}

function openCleaning(tank: TankRow): void {
  cleaningTankId.value = tank.id
  const record = latestCleaning(tank.id)
  CLEANING_STEPS.forEach((name) => {
    const step = record ? stepOf(record, name) : null
    stepInputs[name] = step ? step.value : stepInputs[name]
  })
  cleaningDialog.value = true
}

async function beginCleaning(): Promise<void> {
  if (!cleaningTankId.value) return
  await store.beginCleaning(cleaningTankId.value)
  ElMessage.success('已建立清洗记录，请按 碱洗 → 消毒 → 冲洗 顺序录入')
}

async function submitStep(name: CleaningStepName): Promise<void> {
  const record = cleaningRecord.value
  if (!record) return
  if (!operator.value.trim()) {
    ElMessage.warning('请填写操作人')
    return
  }
  const correcting = stepOf(record, name) !== null
  try {
    await store.recordStep(record.id, name, stepInputs[name], operator.value.trim())
    ElMessage.success(
      correcting
        ? `「${name}」已更正，后续步骤立即失效，请按顺序重录；已放行状态同步撤销`
        : `「${name}」已记录${cleaningStepPassedHint(name)}`
    )
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '记录失败')
  }
}

function cleaningStepPassedHint(name: CleaningStepName): string {
  const rule = CLEANING_STEP_RULES[name]
  const value = stepInputs[name]
  return value >= rule.min && value <= rule.max ? '（达标）' : '（未达标，需调整后更正）'
}

async function doRelease(): Promise<void> {
  const record = cleaningRecord.value
  const tank = cleaningTank.value
  if (!record || !tank) return
  try {
    await store.release(record.id)
    ElMessage.success(`罐 ${tank.code} 清洗已放行，罐位转「空闲」，可分配给新批次`)
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '放行失败')
  }
}

/* ------------------------------ 分配批次 ------------------------------ */

/** 为该罐分配一个在罐批次（事务内校验放行与占用；失败保留现场并列出失效步骤） */
async function assignBatch(tank: TankRow): Promise<void> {
  const candidates = batches.value.filter((batch) => batch.state !== '已出罐' && batch.tankId !== tank.id)
  if (candidates.length === 0) {
    ElMessage.info('暂无待分配的在罐批次')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt(
      `可分配批次：\n${candidates.map((batch) => `${batch.id}（${batchLabel(batch)}）`).join('\n')}`,
      `为罐 ${tank.code} 分配批次`,
      { inputPlaceholder: '粘贴批次 id', confirmButtonText: '分配', cancelButtonText: '取消' }
    )
    const picked = candidates.find((batch) => batch.id === value.trim())
    if (!picked) {
      ElMessage.error('批次 id 不存在，请重新选择')
      return
    }
    await store.assignBatch(picked.id, tank.id)
    ElMessage.success('罐位已分配，清洗放行记录已归档到该批次')
  } catch (error) {
    if (error instanceof Error && error.message) {
      await ElMessageBox.alert(error.message, '分配未成功', { confirmButtonText: '知道了', type: 'warning' })
    }
  }
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
          罐位状态由「出罐 → 待清洗 → 碱洗/消毒/冲洗 → 放行 → 入罐」流程自动驱动；清洗未放行的罐位不可分配。
        </p>
      </div>
      <div>
        <el-button @click="router.push(ROUTES.batches)">去入罐登记</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增发酵罐</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="罐总数" :value="totals.tankCount" suffix="个" icon="Grid" tone="primary" />
      <StatBadge label="已放行（空闲）" :value="totals.freeCount" suffix="个" icon="Files" tone="success" />
      <StatBadge label="待清洗 / 清洗中" :value="totals.pendingCount" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge label="总容量" :value="totals.totalCapacity" suffix="L" icon="Histogram" tone="info" />
      <StatBadge label="罐容利用率" :value="totals.usageRatio" :percent="totals.usageRatio" show-percent tone="warning" icon="PieChart" />
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
          <span class="muted">占用冲突校验：同一罐位同一时刻只允许一个在罐批次</span>
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
        <el-table-column prop="material" label="材质" width="100" />
        <el-table-column prop="capacityL" label="容量(L)" width="100" align="right" />
        <el-table-column prop="tempControl" label="温控方式" width="100" />
        <el-table-column label="罐位状态" width="120">
          <template #default="{ row }">
            <StageTag :value="row.state" />
          </template>
        </el-table-column>
        <el-table-column label="清洗放行" min-width="170">
          <template #default="{ row }">
            <template v-if="latestCleaning(row.id)">
              <StageTag :value="latestCleaning(row.id)!.state" size="small" />
              <span class="muted"> 有效步骤 {{ validStepCount(latestCleaning(row.id)!) }}/3</span>
            </template>
            <span v-else class="muted">无记录</span>
          </template>
        </el-table-column>
        <el-table-column label="占用批次" min-width="180">
          <template #default="{ row }">
            <span v-if="occupancyOf(row.id)">{{ batchLabel(occupancyOf(row.id)) }}</span>
            <span v-else class="muted">未占用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="row.state !== '空闲'" @click="assignBatch(row)">分配批次</el-button>
            <el-button link type="warning" @click="openCleaning(row)">清洗记录</el-button>
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
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="cleaningDialog"
      :title="`清洗放行 · 罐 ${cleaningTank?.code ?? ''}`"
      width="660px"
    >
      <template v-if="cleaningRecord">
        <div class="cleaning-meta">
          <StageTag :value="cleaningRecord.state" />
          <el-tag type="info" effect="plain">触发批次 {{ cleaningRecord.fromBatchId ?? '—（建档 / 旧数据）' }}</el-tag>
          <el-tag type="info" effect="plain">入罐批次 {{ cleaningRecord.toBatchId ?? '—' }}</el-tag>
          <el-tag type="info" effect="plain">
            放行时间 {{ cleaningRecord.releasedAt ? cleaningRecord.releasedAt.slice(0, 16).replace('T', ' ') : '未放行' }}
          </el-tag>
        </div>

        <el-alert
          v-if="cleaningRecord.state === '已消费'"
          type="info"
          :closable="false"
          show-icon
          title="该放行已被入罐批次消费并归档"
          description="步骤只读，作为批次档案的清洗依据；罐位下次出罐后会生成新的清洗记录。"
          class="mb"
        />
        <el-alert
          v-else-if="gaps.length > 0"
          type="warning"
          :closable="false"
          show-icon
          :title="`暂不可放行：${gaps.join('、')}`"
          description="更正任一清洗值后，后续步骤立即失效，需按顺序重录并重新放行。"
          class="mb"
        />
        <el-alert
          v-else
          type="success"
          :closable="false"
          show-icon
          title="三步均已达标，可确认放行"
          class="mb"
        />

        <div class="step-list">
          <div v-for="(name, index) in CLEANING_STEPS" :key="name" class="step-item">
            <div class="step-item__head">
              <span class="step-item__name">{{ index + 1 }}. {{ name }}</span>
              <span class="muted">
                {{ CLEANING_STEP_RULES[name].label }} {{ CLEANING_STEP_RULES[name].min }}–{{ CLEANING_STEP_RULES[name].max }}{{ CLEANING_STEP_RULES[name].unit }}
              </span>
              <StageTag :value="stepStatus(cleaningRecord, name)" size="small" />
            </div>
            <div v-if="stepOf(cleaningRecord, name)" class="step-item__meta">
              实测 {{ stepOf(cleaningRecord, name)!.value }}{{ CLEANING_STEP_RULES[name].unit }} ·
              {{ stepOf(cleaningRecord, name)!.operator }} ·
              {{ stepOf(cleaningRecord, name)!.recordedAt.slice(0, 16).replace('T', ' ') }}
            </div>
            <div v-if="cleaningRecord.state !== '已消费'" class="step-item__form">
              <el-input-number
                v-model="stepInputs[name]"
                :step="name === '消毒' ? 5 : 0.1"
                :precision="name === '消毒' ? 0 : 1"
                :disabled="!canRecord(cleaningRecord, name)"
                size="small"
              />
              <el-button
                size="small"
                :type="stepOf(cleaningRecord, name) ? 'warning' : 'primary'"
                :disabled="!canRecord(cleaningRecord, name)"
                @click="submitStep(name)"
              >
                {{ stepOf(cleaningRecord, name) ? '更正（后续步骤将失效）' : '记录' }}
              </el-button>
              <span v-if="!canRecord(cleaningRecord, name)" class="muted">请先完成前序步骤</span>
            </div>
          </div>
        </div>

        <div v-if="cleaningRecord.state !== '已消费'" class="operator-row">
          <el-input v-model="operator" placeholder="操作人（记录 / 更正时必填）" class="operator-row__input" />
        </div>
      </template>

      <EmptyPanel
        v-else
        title="尚无清洗记录"
        description="该罐还没有清洗放行记录，建立后按 碱洗 → 消毒 → 冲洗 顺序录入。"
        create-text="开始清洗"
        @create="beginCleaning"
      />

      <template #footer>
        <el-button @click="cleaningDialog = false">关闭</el-button>
        <el-button
          v-if="cleaningRecord && cleaningRecord.state !== '已消费'"
          type="primary"
          :disabled="!releasable"
          @click="doRelease"
        >
          确认放行
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.mb {
  margin-bottom: 12px;
}

.cleaning-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.step-item {
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
}

.step-item__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-item__name {
  font-weight: 600;
}

.step-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.step-item__form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.operator-row {
  margin-top: 12px;
}

.operator-row__input {
  max-width: 280px;
}
</style>
