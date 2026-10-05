/** 清洗步骤名称：必须按 碱洗 → 消毒 → 冲洗 顺序记录 */
export type CleaningStepName = '碱洗' | '消毒' | '冲洗'

/** 清洗放行记录状态：清洗中 → 已放行 → 已消费（被入罐批次占用） */
export type CleaningState = '清洗中' | '已放行' | '已消费'

/** 单个清洗步骤的实测记录 */
export interface CleaningStep {
  /** 步骤名称 */
  step: CleaningStepName
  /** 实测值（碱液浓度% / 消毒剂浓度ppm / 冲洗水pH） */
  value: number
  /** 记录时是否达标 */
  passed: boolean
  /** 操作人 */
  operator: string
  /** 记录时间 ISO */
  recordedAt: string
  /** 是否已失效（前序步骤被更正后，后续步骤立即失效） */
  invalidated: boolean
}

/** 清洗放行记录：出罐触发、三步达标后放行、入罐时消费，全程可追溯 */
export interface CleaningRecord {
  id: string
  /** 发酵罐 id */
  tankId: string
  /** 触发本次清洗的出罐批次 id（旧数据迁移 / 新罐建档时为 null） */
  fromBatchId: string | null
  /** 消费本次放行的入罐批次 id */
  toBatchId: string | null
  /** 已记录的步骤（每步最多一条，更正即覆盖并使后续步骤失效） */
  steps: CleaningStep[]
  /** 放行状态 */
  state: CleaningState
  /** 放行时间 ISO（更正清洗值后清空，需重新放行） */
  releasedAt: string | null
}

export const CLEANING_STEPS: CleaningStepName[] = ['碱洗', '消毒', '冲洗']
export const CLEANING_STATES: CleaningState[] = ['清洗中', '已放行', '已消费']

/** 各步骤达标区间与单位 */
export const CLEANING_STEP_RULES: Record<CleaningStepName, { label: string; unit: string; min: number; max: number }> = {
  碱洗: { label: '碱液浓度', unit: '%', min: 1.5, max: 3 },
  消毒: { label: '消毒剂浓度', unit: 'ppm', min: 80, max: 200 },
  冲洗: { label: '冲洗水pH', unit: '', min: 6.5, max: 8.5 }
}

/** 判定某步骤的实测值是否达标 */
export function cleaningStepPassed(step: CleaningStepName, value: number): boolean {
  const rule = CLEANING_STEP_RULES[step]
  return value >= rule.min && value <= rule.max
}

/** 取出记录中某一步（可能不存在） */
export function stepOf(record: CleaningRecord, step: CleaningStepName): CleaningStep | null {
  return record.steps.find((item) => item.step === step) ?? null
}

/** 步骤是否有效（已记录且未失效） */
export function isStepValid(step: CleaningStep | null): step is CleaningStep {
  return step !== null && !step.invalidated
}

/** 是否满足放行条件：三步全部已记录、未失效且达标 */
export function cleaningReleasable(record: CleaningRecord): boolean {
  return CLEANING_STEPS.every((name) => {
    const step = stepOf(record, name)
    return isStepValid(step) && step.passed
  })
}

/** 放行是否仍然有效（已放行或已被入罐消费，且三步当时均达标） */
export function cleaningQualified(record: CleaningRecord): boolean {
  return record.state !== '清洗中' && cleaningReleasable(record)
}

/** 下一个可记录的步骤：按顺序第一个缺失或已失效的步骤；全部有效时返回 null */
export function nextRecordableStep(record: CleaningRecord): CleaningStepName | null {
  for (const name of CLEANING_STEPS) {
    if (!isStepValid(stepOf(record, name))) return name
  }
  return null
}

/** 逐步骤的缺口描述（未记录 / 已失效 / 未达标），用于阻塞放行与分配时的可读提示 */
export function cleaningGaps(record: CleaningRecord | null | undefined): string[] {
  if (!record) return ['无清洗记录']
  if (record.state === '已消费') {
    return [`放行已被批次 ${record.toBatchId ?? '未知'} 消费，碱洗/消毒/冲洗 需重新记录并放行`]
  }
  const gaps: string[] = []
  for (const name of CLEANING_STEPS) {
    const step = stepOf(record, name)
    if (!step) gaps.push(`${name} 未记录`)
    else if (step.invalidated) gaps.push(`${name} 已失效（前序清洗值被更正）`)
    else if (!step.passed) gaps.push(`${name} 未达标（${step.value}${CLEANING_STEP_RULES[name].unit}）`)
  }
  return gaps
}

/** 某罐新建清洗记录（出罐 / 建档 / 迁移时触发） */
export function createEmptyCleaning(tankId: string, fromBatchId: string | null, id: string): CleaningRecord {
  return { id, tankId, fromBatchId, toBatchId: null, steps: [], state: '清洗中', releasedAt: null }
}
