/**
 * 入罐批次 store：维护在罐批次、当前选中批次与罐位清洗放行门槛。
 * 入罐 / 改绑都在一个 IndexedDB 事务内完成，跨标签页同时提交时只有一方能占用罐位。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Batch } from '@/types/batch'
import type { CleaningStepKind } from '@/types/cleaning'
import type { FilterModel } from '@/types/filter'
import type { BatchRow } from '@/utils/db'
import {
  createBatchAssigned,
  removeBatch,
  shipBatch as shipBatchRow,
  rebindBatchTank,
  updateBatch as updateBatchRow,
  TankGateError,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'

export const BATCH_FILTER_KEYS = ['states', 'parcelIds']

/** 入罐被门槛 / 并发占用拒绝时抛出：页面据此保留草稿并指出失效步骤 */
export class BatchSubmitError extends Error {
  /** 未达标或已失效的清洗步骤 */
  failedSteps: CleaningStepKind[]
  /** 是否被其它标签页 / 其它批次抢先占用（占用冲突时 failedSteps 为空） */
  occupied: boolean

  constructor(message: string, failedSteps: CleaningStepKind[], occupied: boolean) {
    super(message)
    this.name = 'BatchSubmitError'
    this.failedSteps = failedSteps
    this.occupied = occupied
  }
}

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

  /**
   * 入罐登记：事务内校验清洗放行（碱洗 / 消毒 / 冲洗全部合格）并占用罐位。
   * 两个标签页同时提交同一罐位时，后到者收到 BatchSubmitError，由页面保留草稿。
   */
  async function createBatch(payload: Omit<Batch, 'id' | 'lastOperationAt'>): Promise<string> {
    error.value = null
    if (!payload.parcelId) throw new Error('请选择地块')
    if (!payload.tankId) throw new Error('请选择发酵罐')
    const id = createId('batch')
    const row: BatchRow = {
      ...payload,
      id,
      lastOperationAt: null,
      revision: ROW_REVISION,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    try {
      await createBatchAssigned(row)
    } catch (err) {
      throw toBatchSubmitError(err)
    }
    currentBatchId.value = id
    return id
  }

  /** 改绑罐位：事务内校验新罐放行单、占用新罐并把旧罐打回待清洗 */
  async function updateBatch(id: string, patch: Partial<Batch>, current: BatchRow): Promise<void> {
    error.value = null
    if (patch.tankId && patch.tankId !== current.tankId) {
      try {
        await rebindBatchTank(id, patch.tankId, current.tankId)
      } catch (err) {
        throw toBatchSubmitError(err)
      }
    }
    await updateBatchRow(id, patch)
  }

  function toBatchSubmitError(err: unknown): BatchSubmitError {
    if (err instanceof TankGateError) {
      const occupied = err.failedSteps.length === 0
      const tail = occupied
        ? '该罐可能已在其它标签页被占用，入罐草稿已保留，请改选其它罐位'
        : `失效 / 未达标步骤：${err.failedSteps.join('、')}；入罐草稿已保留，请重做后再提交`
      return new BatchSubmitError(`${err.message}。${tail}`, err.failedSteps, occupied)
    }
    if (err instanceof Error) return new BatchSubmitError(err.message, [], false)
    return new BatchSubmitError('入罐失败', [], false)
  }

  async function deleteBatch(id: string): Promise<void> {
    await removeBatch(id)
    if (currentBatchId.value === id) currentBatchId.value = null
  }

  /** 出罐：批次归档，罐位进入待清洗并开启清洗放行单 */
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
