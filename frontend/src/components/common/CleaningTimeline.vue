<script setup lang="ts">
/**
 * CleaningTimeline：按「碱洗 → 消毒 → 冲洗」顺序展示清洗放行单的步骤记录。
 * - 每步只认最新一条非失效记录；被上游更正连带失效、或被同步骤新记录取代的历史记录留痕展示；
 * - 前序未合格时后续步骤不可记录（disabled），由清洗看板传入 canRecord。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import {
  CircleCheckFilled,
  CircleCloseFilled,
  Clock,
  RefreshLeft,
  WarningFilled
} from '@element-plus/icons-vue'
import type { CleaningRelease, CleaningStep, CleaningStepKind } from '@/types/cleaning'
import {
  CLEANING_STANDARD,
  CLEANING_STEPS,
  canRecordStep,
  findStep,
  isStepValuePass,
  standardRangeText,
  stepRecords
} from '@/types/cleaning'

const props = defineProps<{
  release: CleaningRelease | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  (event: 'record', payload: { kind: CleaningStepKind; value: number; operator: string }): void
}>()

const dialogKind = ref<CleaningStepKind | null>(null)
const dialogVisible = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({ value: 0, operator: '' })

const locked = computed(() => props.release?.state === '已占用')

function currentStep(kind: CleaningStepKind): CleaningStep | null {
  return props.release ? findStep(props.release, kind) : null
}

function history(kind: CleaningStepKind): CleaningStep[] {
  return props.release ? stepRecords(props.release, kind) : []
}

/** 该步骤卡片上的状态：pass / fail / invalid / pending */
function stepStatus(kind: CleaningStepKind): 'pass' | 'fail' | 'invalid' | 'pending' {
  if (!props.release) return 'pending'
  const step = findStep(props.release, kind)
  if (!step) {
    // 当前记录缺失但存在失效历史：等待重做
    return history(kind).some((item) => item.state === '失效') ? 'invalid' : 'pending'
  }
  if (step.state === '合格') return 'pass'
  if (step.state === '不合格') return 'fail'
  return 'invalid'
}

function statusText(kind: CleaningStepKind): string {
  switch (stepStatus(kind)) {
    case 'pass':
      return '合格'
    case 'fail':
      return '不合格'
    case 'invalid':
      return '已失效，需重做'
    default:
      return '待记录'
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

function canRecord(kind: CleaningStepKind): boolean {
  if (!props.release || props.disabled || locked.value) return false
  return canRecordStep(props.release, kind)
}

function openRecord(kind: CleaningStepKind): void {
  if (!canRecord(kind)) return
  dialogKind.value = kind
  const standard = CLEANING_STANDARD[kind]
  const previous = currentStep(kind)
  form.value = previous?.value ?? Number(((standard.min + standard.max) / 2).toFixed(standard.decimals))
  form.operator = previous?.operator ?? ''
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!dialogKind.value) return
  if (form.value === null || Number.isNaN(form.value)) {
    ElMessage.warning('请填写清洗值')
    return
  }
  emit('record', { kind: dialogKind.value, value: Number(form.value), operator: form.operator })
  dialogVisible.value = false
}

const previewPass = computed(() => (dialogKind.value ? isStepValuePass(dialogKind.value, Number(form.value)) : true))
</script>

<template>
  <div class="clean-steps">
    <el-alert
      v-if="locked"
      type="info"
      :closable="false"
      show-icon
      title="该放行单已被入罐批次占用，清洗记录已锁定"
      class="clean-steps__lock"
    />
    <el-alert
      v-else-if="release && release.state === '已放行'"
      type="success"
      :closable="false"
      show-icon
      title="三步全部合格，罐位已放行，可分配新批次入罐"
      :description="`放行时间：${formatTime(release.releasedAt)}`"
      class="clean-steps__lock"
    />

    <el-steps :active="release ? CLEANING_STEPS.filter((k) => stepStatus(k) === 'pass').length : 0" align-center finish-status="success">
      <el-step v-for="kind in CLEANING_STEPS" :key="kind" :title="kind" />
    </el-steps>

    <div class="clean-steps__grid">
      <el-card
        v-for="kind in CLEANING_STEPS"
        :key="kind"
        shadow="never"
        class="clean-card"
        :class="`is-${stepStatus(kind)}`"
      >
        <div class="clean-card__head">
          <span class="clean-card__title">{{ kind }}</span>
          <el-icon v-if="stepStatus(kind) === 'pass'" class="is-pass"><CircleCheckFilled /></el-icon>
          <el-icon v-else-if="stepStatus(kind) === 'fail'" class="is-fail"><CircleCloseFilled /></el-icon>
          <el-icon v-else-if="stepStatus(kind) === 'invalid'" class="is-invalid"><WarningFilled /></el-icon>
          <el-icon v-else class="is-pending"><Clock /></el-icon>
        </div>
        <div class="clean-card__standard">
          {{ CLEANING_STANDARD[kind].label }}标准 {{ standardRangeText(kind) }}
        </div>
        <div class="clean-card__value">
          <template v-if="currentStep(kind)">
            <strong>{{ currentStep(kind)?.value }}</strong>
            <span>{{ CLEANING_STANDARD[kind].unit }}</span>
            <el-tag
              size="small"
              :type="stepStatus(kind) === 'pass' ? 'success' : stepStatus(kind) === 'fail' ? 'danger' : 'warning'"
              effect="plain"
              class="clean-card__tag"
            >
              {{ statusText(kind) }}
            </el-tag>
          </template>
          <span v-else class="muted">{{ statusText(kind) }}</span>
        </div>
        <div class="clean-card__meta">
          <div>记录人：{{ currentStep(kind)?.operator ?? '—' }}</div>
          <div>记录时间：{{ formatTime(currentStep(kind)?.recordedAt ?? null) }}</div>
        </div>

        <div v-for="item in history(kind).filter((s) => s.state === '失效')" :key="`${item.recordedAt}-${item.value}`" class="clean-card__history">
          <el-icon><RefreshLeft /></el-icon>
          <span>
            原值 {{ item.value }}{{ CLEANING_STANDARD[kind].unit }}（{{ item.operator }}，{{ formatTime(item.recordedAt) }}）
            已于 {{ formatTime(item.invalidatedAt) }} 失效
          </span>
        </div>

        <el-button
          class="clean-card__btn"
          :type="stepStatus(kind) === 'pass' ? 'warning' : 'primary'"
          plain
          size="small"
          :disabled="!canRecord(kind)"
          @click="openRecord(kind)"
        >
          {{ currentStep(kind) ? '更正清洗值' : '记录' }}{{ kind }}
        </el-button>
        <p v-if="!canRecord(kind) && !locked" class="clean-card__hint">需前序步骤全部合格后方可记录</p>
      </el-card>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="`记录${dialogKind}清洗值`"
      width="440px"
      append-to-body
    >
      <el-alert
        :type="previewPass ? 'success' : 'error'"
        :closable="false"
        show-icon
        class="clean-steps__dialog-alert"
        :title="`${CLEANING_STANDARD[dialogKind ?? '碱洗'].label}合格区间 ${standardRangeText(dialogKind ?? '碱洗')}，当前值${previewPass ? '合格' : '不合格'}`"
        :description="dialogKind === '碱洗' ? '保存后若与原值不同，消毒、冲洗记录将立即失效，需重做' : undefined"
      />
      <el-form ref="formRef" :model="form" label-width="92px">
        <el-form-item :label="`${CLEANING_STANDARD[dialogKind ?? '碱洗'].label}（${CLEANING_STANDARD[dialogKind ?? '碱洗'].unit || 'pH'}）`" required>
          <el-input-number
            v-model="form.value"
            :precision="CLEANING_STANDARD[dialogKind ?? '碱洗'].decimals"
            :step="dialogKind === '消毒' ? 0.5 : 0.1"
            :min="0"
            :max="dialogKind === '消毒' ? 100 : 14"
          />
        </el-form-item>
        <el-form-item label="记录人">
          <el-input v-model="form.operator" placeholder="班组 / 操作人姓名" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :type="previewPass ? 'primary' : 'warning'" @click="submit">
          {{ previewPass ? '保存记录' : '保存（不合格，需重做）' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.clean-steps__lock {
  margin-bottom: 14px;
}

.clean-steps__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.clean-card {
  border-radius: 10px;
}

.clean-card.is-pass {
  border-color: #93c9a5;
}

.clean-card.is-fail {
  border-color: #e08b8b;
}

.clean-card.is-invalid {
  border-color: #dfb15f;
}

.clean-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 15px;
  font-weight: 600;
}

.clean-card__head .el-icon {
  font-size: 18px;
}

.is-pass {
  color: #3f8f6b;
}

.is-fail {
  color: #cf5c5c;
}

.is-invalid {
  color: #c9863c;
}

.is-pending {
  color: #9aa5ad;
}

.clean-card__standard {
  margin-top: 6px;
  font-size: 12px;
  color: #8c8479;
}

.clean-card__value {
  margin-top: 8px;
  font-size: 18px;
}

.clean-card__value strong {
  font-size: 24px;
}

.clean-card__tag {
  margin-left: 8px;
}

.muted {
  color: #9aa5ad;
  font-size: 13px;
}

.clean-card__meta {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.8;
  color: #8c8479;
}

.clean-card__history {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #fdf6ec;
  font-size: 12px;
  line-height: 1.5;
  color: #a9792b;
}

.clean-card__btn {
  margin-top: 10px;
  width: 100%;
}

.clean-card__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: #a99f92;
  text-align: center;
}

.clean-steps__dialog-alert {
  margin-bottom: 14px;
}
</style>
