/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与清洗放行流程。
 * 罐位状态不再允许手工直接改写，统一由 出罐 / 清洗步骤 / 放行 / 入罐 流程驱动。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank } from '@/types/tank'
import type { CleaningStepName } from '@/types/cleaning'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  assignBatchToTank,
  recordCleaningStep,
  registerTank,
  releaseCleaning,
  removeTank,
  startCleaning,
  updateTank as updateTankRow
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const TANK_FILTER_KEYS = ['materials', 'tempControls', 'states']

export const useTankStore = defineStore('tank', () => {
  const filters = ref<FilterModel>({ keyword: '', materials: [], tempControls: [], states: [] })
  const selectedId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', materials: [], tempControls: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, TANK_FILTER_KEYS)
  }

  function select(id: string | null): void {
    selectedId.value = id
  }

  /** 找出占用该罐的在罐批次（无则返回 null） */
  function occupancyOf(tankId: string, batches: BatchRow[]): BatchRow | null {
    return batches.find((batch) => batch.tankId === tankId && batch.state !== '已出罐') ?? null
  }

  /** 新罐建档：初始「待清洗」，完成三步清洗放行后才可分配 */
  async function createTank(payload: Omit<Tank, 'id' | 'state'>): Promise<string> {
    const id = await registerTank(payload)
    selectedId.value = id
    return id
  }

  async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
    await updateTankRow(id, patch)
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /** 罐位还没有清洗记录时补建空记录（兜底入口） */
  async function beginCleaning(tankId: string): Promise<string> {
    return startCleaning(tankId)
  }

  /** 记录 / 更正清洗步骤；更正会使后续步骤立即失效并撤销已放行状态 */
  async function recordStep(cleaningId: string, step: CleaningStepName, value: number, operator: string): Promise<void> {
    busy.value = true
    try {
      await recordCleaningStep(cleaningId, step, value, operator)
    } finally {
      busy.value = false
    }
  }

  /** 三步全部达标后放行，罐位转「空闲」 */
  async function release(cleaningId: string): Promise<void> {
    busy.value = true
    try {
      await releaseCleaning(cleaningId)
    } finally {
      busy.value = false
    }
  }

  /** 把在罐批次分配到该罐（事务内校验放行与占用，失败时抛出含失效步骤的错误） */
  async function assignBatch(batchId: string, tankId: string): Promise<void> {
    busy.value = true
    try {
      await assignBatchToTank(batchId, tankId)
    } finally {
      busy.value = false
    }
  }

  return {
    filters,
    selectedId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    occupancyOf,
    createTank,
    updateTank,
    deleteTank,
    beginCleaning,
    recordStep,
    release,
    assignBatch
  }
})
