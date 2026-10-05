/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbwinetank-db，当前结构版本 version(2)，带 upgrade() 迁移逻辑
 * - 地块 / 发酵罐 / 入罐批次 / 发酵读数 / 作业 / 苹乳 / 品评 / 清洗放行 八张表分表存储
 * - v2 起「出罐 → 待清洗 → 清洗三步（碱洗/消毒/冲洗）→ 放行 → 入罐消费」全程落库可追溯；
 *   入罐占用在单个事务内完成「校验放行 + 建批次 + 消费放行 + 罐位置在用」，
 *   两个标签页同时提交时由 IndexedDB 事务串行化保证只有一方占用成功
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
import {
  cleaningGaps,
  cleaningReleasable,
  cleaningStepPassed,
  createEmptyCleaning,
  CLEANING_STEPS,
  type CleaningRecord,
  type CleaningStepName
} from '../types/cleaning'
import { createId, nowIso } from './uuid'
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
export type CleaningRow = CleaningRecord & Revisioned

class GbWineTankDatabase extends Dexie {
  parcels!: Table<ParcelRow, string>
  tanks!: Table<TankRow, string>
  batches!: Table<BatchRow, string>
  readings!: Table<ReadingRow, string>
  operations!: Table<OperationRow, string>
  mlfs!: Table<MlfRow, string>
  tastings!: Table<TastingRow, string>
  cleanings!: Table<CleaningRow, string>

  constructor(name: string = DB_NAME) {
    super(name)

    this.version(1)
      .stores({
        parcels: 'id, name, variety, aspect, updatedAt',
        tanks: 'id, code, material, tempControl, state, updatedAt',
        batches: 'id, parcelId, tankId, state, harvestDate, updatedAt',
        readings: 'id, batchId, date, updatedAt',
        operations: 'id, batchId, type, state, date, seq, updatedAt',
        mlfs: 'id, batchId, state, updatedAt',
        tastings: 'id, batchId, date, verdict, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['parcels', 'tanks', 'batches', 'readings', 'operations', 'mlfs', 'tastings']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = 1
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    this.version(DB_SCHEMA_VERSION)
      .stores({
        // v2 新增清洗放行表；批次新增 cleaningId 字段（非索引列，无需改 stores）
        cleanings: 'id, tankId, state, updatedAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        // 批次补清洗放行外键（旧数据无放行记录，置 null）
        await tx
          .table('batches')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.cleaningId !== 'string') row.cleaningId = null
            row.revision = ROW_REVISION
            row.updatedAt = now
          })
        // 旧数据升级：非「在用」罐位一律缺放行记录 → 先进入「待清洗」，并补建空清洗记录待班组逐步记录
        const tanks = (await tx.table('tanks').toArray()) as TankRow[]
        for (const tank of tanks) {
          const patch: Record<string, unknown> = { revision: ROW_REVISION, updatedAt: now }
          if (tank.state !== '在用') patch.state = '待清洗'
          await tx.table('tanks').update(tank.id, patch)
          if (tank.state !== '在用') {
            await tx.table('cleanings').put({
              ...createEmptyCleaning(tank.id, null, `cl-mig-${tank.id}`),
              revision: ROW_REVISION,
              createdAt: now,
              updatedAt: now
            })
          }
        }
      })
  }
}

export const db = new GbWineTankDatabase()

/** 供迁移验证等场景按库名另开实例（生产代码请使用单例 db） */
export function openDatabase(name: string): GbWineTankDatabase {
  return new GbWineTankDatabase(name)
}

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

export async function updateTank(id: string, patch: Partial<Tank>): Promise<void> {
  await db.tanks.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 新罐建档：罐位初始为「待清洗」，同时建空清洗记录，完成三步放行前不可分配 */
export async function registerTank(payload: Omit<Tank, 'id' | 'state'>): Promise<string> {
  const id = createId('tank')
  const now = Date.now()
  await db.transaction('rw', db.tanks, db.cleanings, async () => {
    await db.tanks.put({ ...payload, id, state: '待清洗', revision: ROW_REVISION, createdAt: now, updatedAt: now })
    await db.cleanings.put({
      ...createEmptyCleaning(id, null, createId('cl')),
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  })
  return id
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

/* ------------------------------ 清洗放行 ------------------------------ */

export async function listCleanings(): Promise<CleaningRow[]> {
  const rows = await db.cleanings.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 某罐最新一条清洗放行记录（无则 null） */
export async function latestCleaningOf(tankId: string): Promise<CleaningRow | null> {
  const rows = await db.cleanings.where('tankId').equals(tankId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
}

/** 罐位尚无清洗记录时补建空记录（兜底：正常流程下出罐 / 建档 / 迁移都会自动建） */
export async function startCleaning(tankId: string): Promise<string> {
  const existing = await latestCleaningOf(tankId)
  if (existing) return existing.id
  const id = createId('cl')
  const now = Date.now()
  await db.transaction('rw', db.cleanings, db.tanks, async () => {
    await db.cleanings.put({ ...createEmptyCleaning(tankId, null, id), revision: ROW_REVISION, createdAt: now, updatedAt: now })
    await db.tanks.update(tankId, { state: '待清洗', updatedAt: now } as never)
  })
  return id
}

/**
 * 记录 / 更正清洗步骤（碱洗 → 消毒 → 冲洗 按顺序）：
 * - 前序步骤未有效记录时禁止跳步
 * - 清洗值一经写入，后续步骤立即失效，需按顺序重录
 * - 已放行的记录被更正时撤销放行，罐位退回「清洗中」
 * - 已消费的记录是入罐批次档案的一部分，禁止再更正
 */
export async function recordCleaningStep(
  cleaningId: string,
  step: CleaningStepName,
  value: number,
  operator: string
): Promise<void> {
  await db.transaction('rw', db.cleanings, db.tanks, async () => {
    const record = await db.cleanings.get(cleaningId)
    if (!record) throw new Error('清洗记录不存在')
    if (record.state === '已消费') {
      throw new Error('该清洗放行已被入罐批次消费并归档，不可再更正；如需调整请等下次出罐后重新清洗')
    }
    const stepIndex = CLEANING_STEPS.indexOf(step)
    for (let i = 0; i < stepIndex; i += 1) {
      const prev = record.steps.find((item) => item.step === CLEANING_STEPS[i])
      if (!prev || prev.invalidated) {
        throw new Error(`请先完成「${CLEANING_STEPS[i]}」再记录「${step}」，清洗步骤必须按顺序执行`)
      }
    }
    const steps = record.steps.filter((item) => item.step !== step)
    steps.push({
      step,
      value,
      passed: cleaningStepPassed(step, value),
      operator,
      recordedAt: nowIso(),
      invalidated: false
    })
    // 清洗值变化后，后续步骤立即失效
    steps.forEach((item) => {
      if (CLEANING_STEPS.indexOf(item.step) > stepIndex) item.invalidated = true
    })
    const now = Date.now()
    await db.cleanings.update(cleaningId, { steps, state: '清洗中', releasedAt: null, updatedAt: now } as never)
    await db.tanks.update(record.tankId, { state: '清洗中', updatedAt: now } as never)
  })
}

/** 清洗放行：三步全部有效且达标后，记录置「已放行」，罐位转「空闲」可分配 */
export async function releaseCleaning(cleaningId: string): Promise<void> {
  await db.transaction('rw', db.cleanings, db.tanks, async () => {
    const record = await db.cleanings.get(cleaningId)
    if (!record) throw new Error('清洗记录不存在')
    if (record.state === '已消费') throw new Error('该清洗放行已被入罐批次消费，不可重复放行')
    if (!cleaningReleasable(record)) {
      throw new Error(`未达放行条件：${cleaningGaps(record).join('、')}`)
    }
    const now = Date.now()
    await db.cleanings.update(cleaningId, { state: '已放行', releasedAt: nowIso(), updatedAt: now } as never)
    await db.tanks.update(record.tankId, { state: '空闲', updatedAt: now } as never)
  })
}

/**
 * 事务内校验罐位可分配并返回有效放行记录。
 * 失败时抛出含失效步骤的可读错误（另一标签页抢先入罐时，此处读到的是对方提交后的最新状态）。
 */
async function assertTankAssignableTx(tankId: string, batchId: string | null): Promise<CleaningRow> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  const occupant = await db.batches
    .where('tankId')
    .equals(tankId)
    .filter((b) => b.state !== '已出罐' && b.id !== batchId)
    .first()
  const cleaning = await latestCleaningOf(tankId)
  if (occupant) {
    throw new Error(
      `罐 ${tank.code} 已被批次 ${occupant.id} 占用（另一窗口可能已抢先入罐），本次提交未生效；${cleaningGaps(cleaning).join('；')}`
    )
  }
  if (tank.state !== '空闲' || !cleaning || cleaning.state !== '已放行') {
    throw new Error(`罐 ${tank.code} 清洗未放行，暂不可分配：${cleaningGaps(cleaning).join('、')}`)
  }
  return cleaning
}

/** 事务内消费放行：记录置「已消费」并绑定入罐批次，罐位置「在用」 */
async function consumeReleaseTx(release: CleaningRow, batchId: string): Promise<void> {
  const now = Date.now()
  await db.cleanings.update(release.id, { state: '已消费', toBatchId: batchId, updatedAt: now } as never)
  await db.tanks.update(release.tankId, { state: '在用', updatedAt: now } as never)
}

/** 事务内让罐位进入待清洗并新建清洗记录（出罐 / 删批次 / 改绑时调用） */
async function markTankPendingCleaningTx(tankId: string, fromBatchId: string | null): Promise<void> {
  const now = Date.now()
  await db.tanks.update(tankId, { state: '待清洗', updatedAt: now } as never)
  await db.cleanings.put({
    ...createEmptyCleaning(tankId, fromBatchId, createId('cl')),
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
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

/**
 * 入罐登记（原子事务）：校验清洗放行 → 建批次（绑定放行记录）→ 消费放行 → 罐位置「在用」。
 * 两个标签页同时提交同一罐位时，IndexedDB 串行化事务保证只有一方占用成功，
 * 另一方在事务内重读状态并收到含失效步骤的错误，页面侧保留草稿。
 */
export async function createBatchInTank(payload: Omit<Batch, 'id' | 'cleaningId' | 'lastOperationAt'>): Promise<string> {
  const id = createId('batch')
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const release = await assertTankAssignableTx(payload.tankId, null)
    const now = Date.now()
    await db.batches.put({
      ...payload,
      id,
      cleaningId: release.id,
      lastOperationAt: null,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    await consumeReleaseTx(release, id)
  })
  return id
}

/** 把在罐批次分配 / 改绑到指定罐位（原子事务）：新罐消费放行，旧罐转待清洗并新建清洗记录 */
export async function assignBatchToTank(batchId: string, tankId: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const batch = await db.batches.get(batchId)
    if (!batch) throw new Error('批次不存在')
    if (batch.state === '已出罐') throw new Error('批次已出罐，不能再分配罐位')
    if (batch.tankId === tankId) return
    const release = await assertTankAssignableTx(tankId, batchId)
    if (batch.tankId) {
      await markTankPendingCleaningTx(batch.tankId, batchId)
    }
    await db.batches.update(batchId, { tankId, cleaningId: release.id, updatedAt: Date.now() } as never)
    await consumeReleaseTx(release, batchId)
  })
}

/** 内部级联删除：清掉批次下属全部子表数据；占用中的罐位转待清洗并新建清洗记录 */
async function cascadeRemoveBatch(batchId: string): Promise<void> {
  await db.readings.where('batchId').equals(batchId).delete()
  await db.operations.where('batchId').equals(batchId).delete()
  await db.mlfs.where('batchId').equals(batchId).delete()
  await db.tastings.where('batchId').equals(batchId).delete()
  const batch = await db.batches.get(batchId)
  if (batch && batch.tankId && batch.state !== '已出罐') {
    await markTankPendingCleaningTx(batch.tankId, batchId)
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

/** 出罐：批次置为已出罐，罐位转「待清洗」并新建清洗放行记录，三步达标放行前不可再分配 */
export async function shipBatch(id: string): Promise<void> {
  await db.transaction('rw', db.batches, db.tanks, db.cleanings, async () => {
    const batch = await db.batches.get(id)
    if (!batch) throw new Error('批次不存在')
    if (batch.tankId) {
      await markTankPendingCleaningTx(batch.tankId, id)
    }
    await db.batches.update(id, { state: '已出罐', updatedAt: Date.now() } as never)
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
  /** v2 新增；导入 v1 旧备份时缺省为 []，随后按「缺放行 → 待清洗」补齐 */
  cleanings: CleaningRecord[]
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

/** 缺有效放行的非「在用」罐位转入「待清洗」，没有任何清洗记录的补建空记录（导入旧备份后调用） */
async function ensureCleaningCoverage(): Promise<void> {
  const now = Date.now()
  const tanks = await db.tanks.toArray()
  for (const tank of tanks) {
    if (tank.state === '在用') continue
    const latest = await latestCleaningOf(tank.id)
    if (latest && latest.state === '已放行') {
      if (tank.state !== '空闲') await db.tanks.update(tank.id, { state: '空闲', updatedAt: now } as never)
      continue
    }
    if (tank.state !== '待清洗') await db.tanks.update(tank.id, { state: '待清洗', updatedAt: now } as never)
    if (!latest) {
      await db.cleanings.put({
        ...createEmptyCleaning(tank.id, null, `cl-auto-${tank.id}`),
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      })
    }
  }
}

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
      await db.tanks.bulkPut(snapshot.tanks.map(stamp))
      await db.batches.bulkPut(snapshot.batches.map(stamp))
      await db.readings.bulkPut(snapshot.readings.map(stamp))
      await db.operations.bulkPut(snapshot.operations.map(stamp))
      await db.mlfs.bulkPut(snapshot.mlfs.map(stamp))
      await db.tastings.bulkPut(snapshot.tastings.map(stamp))
      // v1 旧备份没有 cleanings 字段，按空数组处理
      await db.cleanings.bulkPut((snapshot.cleanings ?? []).map(stamp))
    }
  )
  // 旧备份缺放行记录的罐位：先进入待清洗（与 v2 迁移同一规则）
  await ensureCleaningCoverage()
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
