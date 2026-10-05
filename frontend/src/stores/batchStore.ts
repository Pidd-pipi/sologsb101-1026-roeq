/**
 * 入罐批次 store：维护在罐批次、当前选中批次与地块/罐绑定校验。
 * 入罐 / 改绑在单个事务内完成「校验清洗放行 + 占用罐位 + 消费放行」，
 * 两个标签页同时提交时只有一方成功，另一方收到含失效步骤的错误并保留草稿。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  assignBatchToTank,
  createBatchInTank,
  removeBatch,
  shipBatch as shipBatchRow,
  updateBatch as updateBatchRow
} from '@/utils/db'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

export const useBatchStore = defineStore('batch', () => {
  const filters = ref<FilterModel>({ keyword: '', states: [], parcelIds: [] })
  /** 当前选中的批次 id（读数页、作业页共用上下文） */
  const currentBatchId = ref<string | null>(null)
  const error = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', states: [], parcelIds: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, BATCH_FILTER_KEYS)
    if (typeof query.batchId === 'string' && query.batchId.length > 0) {
      currentBatchId.value = query.batchId
    }
  }

  function select(id: string | null): void {
    currentBatchId.value = id
  }

  /** 入罐登记：事务内校验清洗放行并占用罐位；冲突 / 未放行时抛错，调用方保留表单草稿 */
  async function createBatch(payload: Omit<Batch, 'id' | 'cleaningId' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    try {
      const id = await createBatchInTank(payload)
      currentBatchId.value = id
      return id
    } catch (err) {
      error.value = err instanceof Error ? err.message : '入罐失败'
      throw err
    }
  }

  /** 改绑罐位：新罐需已放行（事务内消费），旧罐自动转待清洗 */
  async function updateBatch(id: string, patch: Partial<Batch>, current: BatchRow): Promise<void> {
    error.value = null
    if (patch.tankId && patch.tankId !== current.tankId) {
      await assignBatchToTank(id, patch.tankId)
      const { tankId: _tankId, ...rest } = patch
      if (Object.keys(rest).length > 0) await updateBatchRow(id, rest)
      return
    }
    await updateBatchRow(id, patch)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：批次归档，罐位转「待清洗」并新建清洗放行记录 */
  async function ship(id: string): Promise<void> {
    await shipBatchRow(id)
  }

  return {
    filters,
    currentBatchId,
    error,
    setFilters,
    resetFilters,
    applyQuery,
    select,
    createBatch,
    updateBatch,
    deleteBatch,
    ship
  }
})
