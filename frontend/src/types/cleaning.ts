/**
 * 罐位清洗放行：把「出罐 → 罐位清洗 → 入罐」串成一条可追溯链条。
 * 碱洗、消毒、冲洗三个步骤必须按顺序记录；任一步骤的清洗值被更正后，
 * 其后续步骤立即失效，需要重做；三步全部合格才放行，入罐只能占用已放行罐位。
 */
import { TANK_STATES, type TankState } from './tank'

/** 清洗步骤（严格顺序：碱洗 → 消毒 → 冲洗） */
export type CleaningStepKind = '碱洗' | '消毒' | '冲洗'

/**
 * 清洗步骤记录状态：
 * - 合格 / 不合格：该步骤当前一次记录的结果；
 * - 失效：上游步骤清洗值被更正而连带失效，或被同步骤的更新记录取代（痕迹保留）。
 */
export type CleaningStepState = '合格' | '不合格' | '失效'

/** 清洗放行状态（罐位状态由其派生） */
export type CleaningReleaseState = '待清洗' | '清洗中' | '已放行' | '已占用'

/** 单步清洗记录 */
export interface CleaningStep {
  /** 步骤类型 */
  kind: CleaningStepKind
  /** 记录状态：合格 / 不合格 / 因上游更正而失效 */
  state: CleaningStepState
  /** 清洗值：碱洗 NaOH 浓度 %、消毒温度 ℃、冲洗 pH */
  value: number | null
  /** 记录人 */
  operator: string
  /** 记录时间 ISO */
  recordedAt: string
  /** 失效时间 ISO（仅失效步骤） */
  invalidatedAt: string | null
}

/**
 * 清洗放行单：每个罐位在每次出罐后开启一张，三步合格并放行后才能被新批次入罐；
 * 入罐后单据变为「已占用」，与批次一一对应，作为批次档案中「入罐时罐位已达标」的凭据。
 */
export interface CleaningRelease {
  id: string
  /** 清洗罐位 */
  tankId: string
  /** 触发放行单的出罐批次；旧数据升级补开的单据为 null */
  fromBatchId: string | null
  /** 入罐后占用该罐位的新批次 */
  occupiedByBatchId: string | null
  /** 放行单状态 */
  state: CleaningReleaseState
  /** 三步记录（数组长度 ≤ 3，按 CLEANING_STEPS 顺序） */
  steps: CleaningStep[]
  /** 三步全部合格、点击放行的时间 ISO */
  releasedAt: string | null
  /** 被新批次占用的时间 ISO */
  occupiedAt: string | null
  /** 备注（如旧数据升级标记） */
  note: string
}

export const CLEANING_STEPS: CleaningStepKind[] = ['碱洗', '消毒', '冲洗']

/** 各步骤清洗值的合格区间（闭区间）与展示单位 */
export const CLEANING_STANDARD: Record<
  CleaningStepKind,
  { min: number; max: number; unit: string; label: string; decimals: number }
> = {
  碱洗: { min: 1.5, max: 2.5, unit: '%', label: 'NaOH 浓度', decimals: 2 },
  消毒: { min: 82, max: 88, unit: '℃', label: '热水温度', decimals: 1 },
  冲洗: { min: 6.5, max: 7.5, unit: '', label: '冲洗后 pH', decimals: 2 }
}

/** 罐位状态在原有「空闲 / 在用 / 清洗中」之外新增「待清洗」 */
export const TANK_STATE_DIRTY = '待清洗' as const

/** 罐位看板与筛选使用的全部状态（顺序即看板展示顺序，与 TANK_STATES 保持一致） */
export const TANK_STATES_EXTENDED: TankState[] = TANK_STATES

/** 该步骤的清洗值是否落在合格区间内（null 视为不合格） */
export function isStepValuePass(kind: CleaningStepKind, value: number | null): boolean {
  if (value === null || Number.isNaN(value)) return false
  const standard = CLEANING_STANDARD[kind]
  return value >= standard.min && value <= standard.max
}

/** 某步骤的全部记录（含已失效的历史记录，按时间正序） */
export function stepRecords(release: CleaningRelease, kind: CleaningStepKind): CleaningStep[] {
  return release.steps
    .filter((step) => step.kind === kind)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
}

/** 某步骤的当前有效记录（最新一条非失效记录；无则 null） */
export function findStep(release: CleaningRelease, kind: CleaningStepKind): CleaningStep | null {
  const active = stepRecords(release, kind).filter((step) => step.state !== '失效')
  return active.at(-1) ?? null
}

/** 步骤是否为当前有效记录（未被上游更正连带失效） */
export function isStepActive(step: CleaningStep | null): step is CleaningStep {
  return !!step && step.state !== '失效'
}

/** 该步骤当前是否合格（有效且合格） */
export function isStepPassed(release: CleaningRelease, kind: CleaningStepKind): boolean {
  const step = findStep(release, kind)
  return isStepActive(step) && step.state === '合格'
}

/**
 * 某步骤此刻是否允许记录：
 * 1. 单据未放行 / 未占用（已放行但更正三步之一时由保存逻辑统一打回，此处不拦）；
 * 2. 前序步骤都已经合格。
 */
export function canRecordStep(release: CleaningRelease, kind: CleaningStepKind): boolean {
  if (release.state === '已占用') return false
  const index = CLEANING_STEPS.indexOf(kind)
  return CLEANING_STEPS.slice(0, index).every((prev) => isStepPassed(release, prev))
}

/** 第一个尚未合格（含失效后待重做）的步骤；三步全部合格返回 null */
export function nextPendingStep(release: CleaningRelease): CleaningStepKind | null {
  return CLEANING_STEPS.find((kind) => !isStepPassed(release, kind)) ?? null
}

/** 三步是否全部有效且合格（放行条件） */
export function isReleaseReady(release: CleaningRelease): boolean {
  return CLEANING_STEPS.every((kind) => isStepPassed(release, kind))
}

/**
 * 由放行单内容重新判定状态：
 * 已占用优先；三步全合格即可放行；已有有效记录则清洗中；否则待清洗。
 */
export function deriveReleaseState(release: CleaningRelease): CleaningReleaseState {
  if (release.occupiedByBatchId) return '已占用'
  if (isReleaseReady(release)) return '已放行'
  if (release.steps.some((step) => step.state !== '失效')) return '清洗中'
  return '待清洗'
}

/** 放行单状态对应的罐位状态 */
export function tankStateOfRelease(release: CleaningRelease | null): TankState {
  if (!release) return '待清洗'
  switch (release.state) {
    case '已占用':
      return '在用'
    case '已放行':
      return '空闲'
    case '清洗中':
      return '清洗中'
    case '待清洗':
    default:
      return '待清洗'
  }
}

/** 人读的步骤标准，如「1.50% ~ 2.50%」 */
export function standardRangeText(kind: CleaningStepKind): string {
  const standard = CLEANING_STANDARD[kind]
  return `${standard.min.toFixed(standard.decimals)} ~ ${standard.max.toFixed(standard.decimals)}${standard.unit}`
}

/** 生成一条空放行单 */
export function createEmptyCleaningRelease(
  tankId: string,
  fromBatchId: string | null,
  note = ''
): Omit<CleaningRelease, 'id'> {
  return {
    tankId,
    fromBatchId,
    occupiedByBatchId: null,
    state: '待清洗',
    steps: [],
    releasedAt: null,
    occupiedAt: null,
    note
  }
}
