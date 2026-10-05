/**
 * 发酵罐 store：维护罐位占用、容量筛选条件与占用冲突校验。
 * 罐位状态不再允许手工切换，统一由「出罐 → 清洗放行 → 入罐」链条派生。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Tank } from '@/types/tank'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  assignBatchToTank,
  createTankWithCleaning,
  removeTank,
  updateTank as updateTankRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
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

  /** 新建罐位：状态固定为「待清洗」，并同步开启清洗放行单 */
  async function createTank(payload: Omit<Tank, 'id' | 'state'>): Promise<string> {
    const now = Date.now()
    const id = createId('tank')
    await createTankWithCleaning({
      ...payload,
      state: '待清洗',
      id,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    selectedId.value = id
    return id
  }

  async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
    // 罐位状态由清洗放行单派生，编辑保存时忽略前端传入的 state
    const { state: _state, ...allowed } = patch
    void _state
    await updateTankRow(id, allowed)
  }

  async function deleteTank(id: string): Promise<void> {
    await removeTank(id)
    if (selectedId.value === id) selectedId.value = null
  }

  /**
   * 为罐位分配在罐批次（事务内执行）：新批次入罐必须通过清洗放行门槛，
   * 跨标签页并发时后到者会被 IndexedDB 事务拒绝。
   */
  async function assign(tankId: string, batchId: string): Promise<void> {
    busy.value = true
    try {
      await assignBatchToTank(tankId, batchId)
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
    assign
  }
})
