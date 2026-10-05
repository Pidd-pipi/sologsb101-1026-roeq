/**
 * 清洗放行 store：维护罐位清洗看板的筛选条件、当前选中罐位，
 * 封装「记录清洗步骤 / 重新清洗」动作；罐位状态与放行单的派生规则在 types/cleaning.ts。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { CleaningStepKind } from '@/types/cleaning'
import type { FilterModel } from '@/types/filter'
import { recordCleaningStep as recordCleaningStepRow, restartCleaning as restartCleaningRow } from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const CLEANING_FILTER_KEYS = ['states', 'materials']

export const useCleaningStore = defineStore('cleaning', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], materials: [] })
  /** 当前展开清洗详情的罐位 id */
  const selectedTankId = ref<string | null>(null)
  const busy = ref(false)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], materials: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CLEANING_FILTER_KEYS)
    if (typeof query.tankId === 'string' && query.tankId.length > 0) {
      selectedTankId.value = query.tankId
    }
  }

  function selectTank(tankId: string | null): void {
    selectedTankId.value = tankId
  }

  /** 记录一步清洗；更正清洗值后后续步骤会在事务内立即失效 */
  async function recordStep(releaseId: string, kind: CleaningStepKind, value: number, operator: string): Promise<void> {
    busy.value = true
    try {
      await recordCleaningStepRow(releaseId, kind, value, operator)
    } finally {
      busy.value = false
    }
  }

  /** 已放行（空闲）罐位重新清洗：作废旧放行单，罐位回到待清洗 */
  async function restart(tankId: string): Promise<void> {
    busy.value = true
    try {
      await restartCleaningRow(tankId)
    } finally {
      busy.value = false
    }
  }

  return {
    filters,
    selectedTankId,
    busy,
    setFilters,
    resetFilters,
    applyQuery,
    selectTank,
    recordStep,
    restart
  }
})
