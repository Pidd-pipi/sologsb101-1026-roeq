/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 清洗放行 八张表分表存储
 * - 首次打开自动播种互相引用的演示数据，保证每个页面打开都有内容
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie'
import type { Parcel } from '../types/parcel'
import type { Tank } from '../types/tank'
import type { Batch } from '../types/batch'
import type { Reading } from '../types/reading'
import type { Operation } from '../types/operation'
import type { Mlf } from '../types/mlf'
import type { Tasting } from '../types/tasting'
import type { CleaningRelease, CleaningStep, CleaningStepKind } from '../types/cleaning'
import {
  canRecordStep,
  createEmptyCleaningRelease,
  deriveReleaseState,
  isStepValuePass,
  tankStateOfRelease,
  TANK_STATE_DIRTY
} from '../types/cleaning'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbwinetank-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号，便于后续按行迁移 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type ParcelRow = Parcel & Revisioned
export type TankRow = Tank & Revisioned
export type BatchRow = Batch & Revisioned
export type ReadingRow = Reading & Revisioned
export type OperationRow = Operation & Revisioned
export type MlfRow = Mlf & Revisioned
export type TastingRow = Tasting & Revisioned
export type CleaningRow = CleaningRelease & Revisioned

/** 入罐放行校验失败：携带罐位与失效步骤，供页面保留草稿并提示 */
export class TankGateError extends Error {
  /** 罐号 */
  tankCode: string
  /** 失效（未合格 / 被更正连带失效）的步骤类型，全部放行通过时为空 */
  failedSteps: CleaningStepKind[]

  constructor(message: string, tankCode: string, failedSteps: CleaningStepKind[]) {
    super(message)
    this.name = 'TankGateError'
    this.tankCode = tankCode
    this.failedSteps = failedSteps
  }
}

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  cleanings!: Table<CleaningRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      parcels: 'id, name, variety, aspect, updatedAt',
      tanks: 'id, code, material, tempControl, state, updatedAt',
      batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
      readings: 'id, batchId, date, updatedAt',
      operations: 'id, batchId, type, state, date, seq, updatedAt',
      mlfs: 'id, batchId, state, updatedAt',
      tastings: 'id, batchId, date, verdict, updatedAt'
    })

    // v2：新增 cleanings 清洗放行表；旧库罐位缺少放行记录，统一升级为「待清洗」
    this.version(2)
      .stores({
        cleanings: 'id, tankId, fromBatchId, occupiedByBatchId, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        // v1 迁移：为历史行补齐行修订号与时间戳
        const legacyTables = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of legacyTables) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = 1
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }

        // 缺放行记录的罐位先进入「待清洗」：仍有在罐批次的保持「在用」，
        // 其批次出罐时会自动开启放行单；其余罐位（含当时只显示「清洗中」、
        // 冲洗是否合格无据可查的）一律补开一张「待清洗」放行单。
        const batches = await tx.table<BatchRow, string>('batches').toArray()
        const tanks = await tx.table<TankRow, string>('tanks').toArray()
        const upgrades: CleaningRow[] = []
        for (const tank of tanks) {
          const activeBatch = batches.find(
            (batch) => batch.tankId === tank.id && batch.state !== '已出罐'
          )
          if (activeBatch) {
            // 在用罐：补一张已占用占位单据，标注入罐时清洗标准无据可查（追溯缺口如实呈现）
            upgrades.push({
              id: `cln-upgrade-${tank.id}`,
              tankId: tank.id,
              fromBatchId: null,
              occupiedByBatchId: activeBatch.id,
              state: '已占用',
              steps: [],
              releasedAt: null,
              occupiedAt: new Date(activeBatch.createdAt ?? now).toISOString(),
              note: '旧数据升级：该批次入罐时的清洗放行记录缺失，本单据为系统补建',
              revision: ROW_REVISION,
              createdAt: tank.createdAt ?? now,
              updatedAt: now
            })
            await tx.table('tanks').update(tank.id, { state: '在用', updatedAt: now })
            continue
          }
          await tx.table('tanks').update(tank.id, { state: TANK_STATE_DIRTY, updatedAt: now })
          upgrades.push({
            ...createEmptyCleaningRelease(
              tank.id,
              null,
              '旧数据升级：该罐缺少清洗放行记录，先进入待清洗，需重新完成碱洗 / 消毒 / 冲洗'
            ),
            id: `cln-upgrade-${tank.id}`,
            revision: ROW_REVISION,
            createdAt: tank.createdAt ?? now,
            updatedAt: now
          })
        }
        if (upgrades.length > 0) {
          await tx.table<CleaningRow, string>('cleanings').bulkPut(upgrades)
        }
      })
  }
}

export const db = new GbWineTankDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.parcels.count()) === 0) {
    await seedDatabase()
  }
}

/* ------------------------------ 地块 ------------------------------ */

export async function listParcels(): Promise<ParcelRow[]> {
  const rows = await db.parcels.toArray()
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putParcel(row: ParcelRow): Promise<void> {
  await db.parcels.put(row)
}

export async function updateParcel(id: string, patch: Partial<Parcel>): Promise<void> {
  await db.parcels.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除地块：级联删除其下批次及批次的读数/作业/苹乳/品评，并释放占用的罐位 */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.cleanings],
    async () => {
      const batches = await db.batches.where('parcelId').equals(id).toArray()
      for (const batch of batches) {
        await cascadeRemoveBatch(batch.id)
      }
      await db.parcels.delete(id)
    }
  )
}

/* ------------------------------ 发酵罐 ------------------------------ */

export async function listTanks(): Promise<TankRow[]> {
  const rows = await db.tanks.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putTank(row: TankRow): Promise<void> {
  await db.tanks.put(row)
}

/** 新罐建档：同时开启一张待清洗放行单，罐位完成清洗前不能分配批次 */
export async function createTankWithCleaning(row: TankRow): Promise<void> {
  await db.transaction('rw', db.tanks, db.cleanings, async () => {
    const now = Date.now()
    await db.tanks.put(row)
    await db.cleanings.put({
      ...createEmptyCleaningRelease(row.id, null, '新罐建档：完成碱洗 / 消毒 / 冲洗并放行后方可使用'),
      id: `cln-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  })
}

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTank(id: string): Promise<void> {
  const active = await db.batches.where('tankId').equals(id).filter((b) => b.state !== '已出罐').count()
  if (active > 0) {
    throw new Error('该罐仍有在罐批次，请先出罐或改绑其它罐位')
  }
  await db.transaction('rw', db.tanks, db.batches, db.cleanings, async () => {
    await db.batches.where('tankId').equals(id).modify({ tankId: '', updatedAt: Date.now() })
    await db.cleanings.where('tankId').equals(id).delete()
    await db.tanks.delete(id)
  })
}

/* ------------------------------ 入罐批次 ------------------------------ */

export async function listBatches(): Promise<BatchRow[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.harvestDate.localeCompare(a.harvestDate))
}

export async function putBatch(row: BatchRow): Promise<void> {
  await db.batches.put(row)
}

export async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
  await db.batches.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 内部级联删除：清掉批次下属全部子表数据 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId) {
    await releaseTankAfterBatch(batch.tankId, null)
  }
  await db.batches.delete(batchId)
}

export async function removeBatch(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.tanks, db.cleanings],
    async () => {
      await cascadeRemoveBatch(id)
    }
  )
}

/* --------------------------- 清洗放行（出罐 → 清洗 → 入罐） --------------------------- */

export async function listCleanings(): Promise<CleaningRow[]> {
  return db.cleanings.toArray()
}

export async function putCleaning(row: CleaningRow): Promise<void> {
  await db.cleanings.put(row)
}

/** 某罐位的最新一张放行单（updatedAt 最新；无则 null） */
export async function getLatestCleaning(tankId: string): Promise<CleaningRow | null> {
  const rows = await db.cleanings.where('tankId').equals(tankId).toArray()
  if (rows.length === 0) return null
  return rows.reduce((latest, row) => ((row.updatedAt ?? 0) > (latest.updatedAt ?? 0) ? row : latest))
}

/** 某批次入罐时占用的清洗放行单（批次档案追溯用） */
export async function getCleaningByOccupant(batchId: string): Promise<CleaningRow | null> {
  return (await db.cleanings.where('occupiedByBatchId').equals(batchId).first()) ?? null
}

/** 某批次出罐时为罐位开启的清洗放行单（批次档案追溯下一轮清洗用） */
export async function getCleaningBySourceBatch(batchId: string): Promise<CleaningRow | null> {
  return (await db.cleanings.where('fromBatchId').equals(batchId).first()) ?? null
}

/**
 * 释放罐位并开启新的清洗放行单：出罐 / 级联删除共用。
 * 旧单据保留不动作为历史；罐位立即变为「待清洗」，班组无法绕过清洗直接分配。
 */
async function releaseTankAfterBatch(tankId: string, fromBatchId: string | null): Promise<void> {
  const now = Date.now()
  const release: CleaningRow = {
    ...createEmptyCleaningRelease(tankId, fromBatchId),
    id: `cln-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  await db.cleanings.put(release)
  await db.tanks.update(tankId, { state: TANK_STATE_DIRTY, updatedAt: now } as never)
}

/** 出罐：批次置为已出罐，罐位进入「待清洗」并开启清洗放行单 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    if (batch.state === '已出罐') throw new Error('该批次已出罐')
    if (batch.tankId) {
      await releaseTankAfterBatch(batch.tankId, id)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
  })
}

/** 校验入罐门槛：罐位存在、无其它在罐批次占用、最新放行单已放行；返回放行单 */
async function assertTankGate(
  tankId: string,
  batchId: string | null
): Promise<{ tank: TankRow; release: CleaningRow }> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  const occupants = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== batchId)
    .toArray()
  if (occupants.length > 0) {
    throw new TankGateError(`罐 ${tank.code} 已被批次占用，禁止重复分配`, tank.code, [])
  }
  const release = await getLatestCleaning(tankId)
  if (!release || release.state !== '已放行' || !release.releasedAt) {
    const failedSteps = release
      ? (['碱洗', '消毒', '冲洗'] as CleaningStepKind[]).filter((kind) => {
          const step = release.steps.find((item) => item.kind === kind)
          return !step || step.state !== '合格'
        })
      : (['碱洗', '消毒', '冲洗'] as CleaningStepKind[])
    throw new TankGateError(
      release
        ? `罐 ${tank.code} 尚未完成清洗放行（${failedSteps.join(' / ')} 未达标），不可入罐`
        : `罐 ${tank.code} 缺少清洗放行记录，不可入罐`,
      tank.code,
      failedSteps
    )
  }
  return { tank, release }
}

/** 校验罐位是否可以分配给指定批次（供表单选择前的预校验使用） */
export async function assertTankAssignable(tankId: string, batchId: string | null): Promise<void> {
  await assertTankGate(tankId, batchId)
}

/**
 * 入罐登记（原子事务，跨标签页并发安全）：
 * 同一罐位被两个标签页同时提交时，事务串行执行，
 * 后到者在事务内重新校验时会因罐位已占用 / 放行单已消耗而失败，由页面保留草稿。
 */
export async function createBatchAssigned(payload: BatchRow): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const { release } = await assertTankGate(payload.tankId, null)
    const now = Date.now()
    await db.batches.put({ ...payload, createdAt: now, updatedAt: now })
    await db.cleanings.update(release.id, {
      state: '已占用',
      occupiedByBatchId: payload.id,
      occupiedAt: nowIso(),
      updatedAt: now
    } as never)
    await db.tanks.update(payload.tankId, { state: '在用', updatedAt: now } as never)
  })
}

/**
 * 罐位看板直接为在罐批次分配罐位（原子事务）：
 * 批次必须已出罐前的「无罐 / 改绑」场景同样走清洗放行门槛；
 * 跨标签页同时操作同一罐位时后到者失败。
 */
export async function assignBatchToTank(tankId: string, batchId: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.state === '已出罐') throw new Error('已出罐批次不能重新分配罐位')
    const { release } = await assertTankGate(tankId, batchId)
    const now = Date.now()
    const previousTankId = batch.tankId
    await db.batches.update(batchId, { tankId, updatedAt: now } as never)
    await db.cleanings.update(release.id, {
      state: '已占用',
      occupiedByBatchId: batchId,
      occupiedAt: nowIso(),
      updatedAt: now
    } as never)
    await db.tanks.update(tankId, { state: '在用', updatedAt: now } as never)
    if (previousTankId && previousTankId !== tankId) {
      await releaseTankAfterBatch(previousTankId, batchId)
    }
  })
}

/**
 * 改绑罐位（原子事务）：新罐通过放行门槛后，占用其放行单；
 * 旧罐释放为「待清洗」并开启新放行单。
 */
export async function rebindBatchTank(
  batchId: string,
  nextTankId: string,
  currentTankId: string
): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const { release } = await assertTankGate(nextTankId, batchId)
    const now = Date.now()
    await db.batches.update(batchId, { tankId: nextTankId, updatedAt: now } as never)
    await db.cleanings.update(release.id, {
      state: '已占用',
      occupiedByBatchId: batchId,
      occupiedAt: nowIso(),
      updatedAt: now
    } as never)
    await db.tanks.update(nextTankId, { state: '在用', updatedAt: now } as never)
    if (currentTankId) {
      await releaseTankAfterBatch(currentTankId, batchId)
    }
  })
}

/**
 * 记录一步清洗（碱洗 / 消毒 / 冲洗，按顺序）：
 * - 前序步骤未合格不允许记录；
 * - 清洗值落在标准区间外记为「不合格」，不影响后续可记录性（后续仍需本步合格才可记录）；
 * - 更正某步骤的清洗值后，其全部后续步骤立即置为「失效」，必须重做；
 *   若罐位已放行则同步打回为「清洗中」；罐位状态始终由放行单内容派生。
 */
export async function recordCleaningStep(
  releaseId: string,
  kind: CleaningStepKind,
  value: number,
  operator: string
): Promise<void> {
  await db.transaction('rw', db.cleanings, db.tanks, async () => {
    const release = await db.cleanings.get(releaseId)
    if (!release) throw new Error('清洗放行单不存在')
    if (release.state === '已占用') throw new Error('该罐已入罐占用，放行单已锁定，不能再修改清洗记录')
    if (!canRecordStep(release, kind)) {
      throw new Error('请先按顺序完成前序清洗步骤并确保合格')
    }
    const order = ['碱洗', '消毒', '冲洗'] as CleaningStepKind[]
    const index = order.indexOf(kind)
    const nowIsoText = nowIso()
    const step: CleaningStep = {
      kind,
      state: isStepValuePass(kind, value) ? '合格' : '不合格',
      value,
      operator: operator.trim() || '班组',
      recordedAt: nowIsoText,
      invalidatedAt: null
    }
    const steps = [...release.steps]
    // 同步骤重新记录：上一条记录留痕并标为失效（清洗值变化可追溯）
    for (const item of steps) {
      if (item.kind === kind && item.state !== '失效') {
        item.state = '失效'
        item.invalidatedAt = nowIsoText
      }
      // 更正本步后，全部后续步骤立即失效，必须重做
      if (order.indexOf(item.kind) > index && item.state !== '失效') {
        item.state = '失效'
        item.invalidatedAt = nowIsoText
      }
    }
    steps.push(step)
    const nextRelease: CleaningRelease = {
      ...release,
      steps,
      releasedAt: null
    }
    nextRelease.state = deriveReleaseState(nextRelease)
    if (nextRelease.state === '已放行') {
      nextRelease.releasedAt = nowIsoText
    }
    const now = Date.now()
    await db.cleanings.update(releaseId, {
      steps: nextRelease.steps,
      state: nextRelease.state,
      releasedAt: nextRelease.releasedAt,
      updatedAt: now
    } as never)
    await db.tanks.update(release.tankId, {
      state: tankStateOfRelease(nextRelease),
      updatedAt: now
    } as never)
  })
}

/** 重新清洗：对已放行（空闲）的罐位作废旧放行单并开启新单据，罐位回到「待清洗」 */
export async function restartCleaning(tankId: string): Promise<void> {
  await db.transaction('rw', db.tanks, db.cleanings, db.batches, async () => {
    const tank = await db.tanks.get(tankId)
    if (!tank) throw new Error('发酵罐不存在')
    const occupied = await db.batches
      .where('tankId')
      .equals(tankId)
      .filter((b) => b.state !== '已出罐')
      .count()
    if (occupied > 0) throw new Error('该罐仍有在罐批次，不能重新清洗')
    const latest = await getLatestCleaning(tankId)
    if (latest && (latest.state === '清洗中' || latest.state === '待清洗')) {
      throw new Error('该罐已在清洗流程中，请直接补录清洗步骤')
    }
    const now = Date.now()
    const release: CleaningRow = {
      ...createEmptyCleaningRelease(tankId, null, '班组发起重新清洗'),
      id: `cln-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    await db.cleanings.put(release)
    await db.tanks.update(tankId, { state: TANK_STATE_DIRTY, updatedAt: now } as never)
  })
}

/* ------------------------------ 发酵读数 ------------------------------ */

export async function listReadings(): Promise<ReadingRow[]> {
  const rows = await db.readings.toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row)
}

export async function updateReading(id: string, patch: Partial<Reading>): Promise<void> {
  await db.readings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id)
}

/* -------------------------------- 作业 -------------------------------- */

export async function listOperations(): Promise<OperationRow[]> {
  const rows = await db.operations.toArray()
  return rows.sort((a, b) => a.seq - b.seq || a.date.localeCompare(b.date))
}

export async function putOperation(row: OperationRow): Promise<void> {
  await db.operations.put(row)
}

export async function updateOperation(id: string, patch: Partial<Operation>): Promise<void> {
  await db.operations.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeOperation(id: string): Promise<void> {
  await db.operations.delete(id)
}

/** 批量写回拖拽后的作业顺序 */
export async function reorderOperations(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.operations, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.operations.update(orderedIds[index], { seq: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 作业完成：置为已完成并回写批次的最近作业时间 */
export async function completeOperation(id: string): Promise<void> {
  await db.transaction('rw', db.operations, db.batches, async () => {
    const operation = await db.operations.get(id)
    if (!operation) throw new Error('作业不存在')
    await db.operations.update(id, { state: '已完成', updatedAt: Date.now() } as never)
    await db.batches.update(operation.batchId, { lastOperationAt: nowIso(), updatedAt: Date.now() } as never)
  })
}

/** 某个批次现有作业的最大序号 */
export async function nextOperationSeq(batchId: string): Promise<number> {
  const rows = await db.operations.where('batchId').equals(batchId).toArray()
  return rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1
}

/* ------------------------------ 苹乳发酵 ------------------------------ */

export async function listMlfs(): Promise<MlfRow[]> {
  return db.mlfs.toArray()
}

export async function putMlf(row: MlfRow): Promise<void> {
  await db.mlfs.put(row)
}

export async function updateMlf(id: string, patch: Partial<Mlf>): Promise<void> {
  await db.mlfs.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeMlf(id: string): Promise<void> {
  await db.mlfs.delete(id)
}

/* ------------------------------ 品评调配 ------------------------------ */

export async function listTastings(): Promise<TastingRow[]> {
  const rows = await db.tastings.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putTasting(row: TastingRow): Promise<void> {
  await db.tastings.put(row)
}

export async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
  await db.tastings.update(id, { ...patch, updatedAt: Date.now() } as never)
}

export async function removeTasting(id: string): Promise<void> {
  await db.tastings.delete(id)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  parcels: Parcel[]
  tanks: Tank[]
  batches: Batch[]
  readings: Reading[]
  operations: Operation[]
  mlfs: Mlf[]
  tastings: Tasting[]
  cleanings: CleaningRelease[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, cleanings] = await Promise.all([
    db.parcels.toArray(),
    db.tanks.toArray(),
    db.batches.toArray(),
    db.readings.toArray(),
    db.operations.toArray(),
    db.mlfs.toArray(),
    db.tastings.toArray(),
    db.cleanings.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    parcels: parcels.map(stripRow),
    tanks: tanks.map(stripRow),
    batches: batches.map(stripRow),
    readings: readings.map(stripRow),
    operations: operations.map(stripRow),
    mlfs: mlfs.map(stripRow),
    tastings: tastings.map(stripRow),
    cleanings: cleanings.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

/**
 * 导入备份：罐位状态不直接信任快照，统一按「在罐批次 / 最新放行单」重新派生，
 * 保证导入旧版本（无 cleanings）备份时罐位也会落到正确的待清洗 / 在用状态。
 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.cleanings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.cleanings.clear()
      ])
      await db.parcels.bulkPut(snapshot.parcels.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))

      const now = Date.now()
      const hasCleanings = Array.isArray(snapshot.cleanings) && snapshot.cleanings.length > 0
      if (hasCleanings) {
        await db.cleanings.bulkPut(snapshot.cleanings.map(stamp))
      } else {
        // 兼容旧备份：无放行记录的罐位补单——在用罐补「已占用」占位，其余进「待清洗」
        const legacy: CleaningRow[] = snapshot.tanks.map((tank, index) => {
          const activeBatch = snapshot.batches.find(
            (batch) => batch.tankId === tank.id && batch.state !== '已出罐'
          )
          return activeBatch
            ? {
                id: `cln-import-${index + 1}`,
                tankId: tank.id,
                fromBatchId: null,
                occupiedByBatchId: activeBatch.id,
                state: '已占用' as const,
                steps: [],
                releasedAt: null,
                occupiedAt: nowIso(),
                note: '旧备份导入：该批次入罐时的清洗放行记录缺失，本单据为系统补建',
                revision: ROW_REVISION,
                createdAt: now,
                updatedAt: now
              }
            : {
                ...createEmptyCleaningRelease(tank.id, null, '旧备份导入：缺少清洗放行记录，先进入待清洗'),
                id: `cln-import-${index + 1}`,
                revision: ROW_REVISION,
                createdAt: now,
                updatedAt: now
              }
        })
        await db.cleanings.bulkPut(legacy)
      }

      // 罐位状态按在罐批次 + 最新放行单重新派生
      for (const tank of snapshot.tanks) {
        const active = snapshot.batches.some((batch) => batch.tankId === tank.id && batch.state !== '已出罐')
        const latest = await getLatestCleaning(tank.id)
        await db.tanks.put(
          stamp({ ...tank, state: active ? '在用' : latest ? tankStateOfRelease(latest) : TANK_STATE_DIRTY })
        )
      }
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.cleanings],
    async () => {
      await Promise.all([
        db.parcels.clear(),
        db.tanks.clear(),
        db.batches.clear(),
        db.readings.clear(),
        db.operations.clear(),
        db.mlfs.clear(),
        db.tastings.clear(),
        db.cleanings.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计，供页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [parcels, tanks, batches, readings, operations, mlfs, tastings, cleanings] = await Promise.all([
    db.parcels.count(),
    db.tanks.count(),
    db.batches.count(),
    db.readings.count(),
    db.operations.count(),
    db.mlfs.count(),
    db.tastings.count(),
    db.cleanings.count()
  ])
  return { parcels, tanks, batches, readings, operations, mlfs, tastings, cleanings }
}
