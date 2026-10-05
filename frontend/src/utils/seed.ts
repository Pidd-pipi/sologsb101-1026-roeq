/**
 * 首次打开应用时灌入的演示数据
 * 只在 parcels 表为空时执行，地块 → 发酵罐 → 批次 → 读数/作业/苹乳/品评/清洗放行 互相引用，
 * 保证 6 个页面第一次进入都有可点通的内容。函数本身幂等：由调用方判定表是否为空。
 * 清洗放行演示覆盖四种形态：已消费（在罐批次）、已放行（空闲可分配）、清洗中且冲洗未达标、
 * 以及出罐后新建的待清洗空记录。
 */
import type { ParcelRow, TankRow, BatchRow, ReadingRow, OperationRow, MlfRow, TastingRow, CleaningRow } from './db'
import { db, ROW_REVISION } from './db'

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  return { ...row, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now() }
}

const PARCELS: Array<Omit<ParcelRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'p-001', name: '东坡三号地', variety: '赤霞珠', areaMu: 12.5, vineAge: 8, aspect: '南' },
  { id: 'p-002', name: '南坡老藤地', variety: '梅洛', areaMu: 8, vineAge: 15, aspect: '东南' },
  { id: 'p-003', name: '西坡白葡萄地', variety: '霞多丽', areaMu: 5.5, vineAge: 6, aspect: '西' }
]

const TANKS: Array<Omit<TankRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'tk-001', code: 'F-01', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '在用' },
  { id: 'tk-002', code: 'F-02', material: '橡木', capacityL: 2250, tempControl: '无', state: '在用' },
  { id: 'tk-003', code: 'F-03', material: '不锈钢', capacityL: 1500, tempControl: '盘管', state: '空闲' },
  { id: 'tk-004', code: 'F-04', material: '混凝土', capacityL: 5000, tempControl: '夹套', state: '清洗中' }
]

const BATCHES: Array<Omit<BatchRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'b-001',
    parcelId: 'p-001',
    tankId: 'tk-001',
    harvestDate: '2024-09-12',
    volumeL: 2600,
    brix: 24.5,
    state: '酒精发酵',
    cleaningId: 'cl-001',
    lastOperationAt: '2024-09-18T09:20:00.000Z'
  },
  {
    id: 'b-002',
    parcelId: 'p-002',
    tankId: 'tk-002',
    harvestDate: '2024-09-15',
    volumeL: 2000,
    brix: 23,
    state: '苹乳发酵',
    cleaningId: 'cl-002',
    lastOperationAt: '2024-09-27T14:05:00.000Z'
  },
  {
    id: 'b-003',
    parcelId: 'p-003',
    tankId: '',
    harvestDate: '2024-09-20',
    volumeL: 1400,
    brix: 21.5,
    state: '已出罐',
    cleaningId: 'cl-005',
    lastOperationAt: '2024-10-08T08:40:00.000Z'
  }
]

const READINGS: Array<Omit<ReadingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'r-001', batchId: 'b-001', date: '2024-09-12', gravity: 1.102, tempC: 24.5, brix: 24.5 },
  { id: 'r-002', batchId: 'b-001', date: '2024-09-14', gravity: 1.078, tempC: 27.2, brix: 19.4 },
  { id: 'r-003', batchId: 'b-001', date: '2024-09-16', gravity: 1.052, tempC: 31.4, brix: 13.1 },
  { id: 'r-004', batchId: 'b-001', date: '2024-09-18', gravity: 1.03, tempC: 28.6, brix: 7.6 },
  { id: 'r-005', batchId: 'b-002', date: '2024-09-15', gravity: 1.096, tempC: 23.1, brix: 23 },
  { id: 'r-006', batchId: 'b-002', date: '2024-09-19', gravity: 1.04, tempC: 25.8, brix: 10.1 },
  { id: 'r-007', batchId: 'b-002', date: '2024-09-24', gravity: 1.006, tempC: 22.4, brix: 1.6 },
  { id: 'r-008', batchId: 'b-002', date: '2024-09-27', gravity: 1.002, tempC: 21.7, brix: 0.6 },
  { id: 'r-009', batchId: 'b-003', date: '2024-09-20', gravity: 1.09, tempC: 19.8, brix: 21.5 },
  { id: 'r-010', batchId: 'b-003', date: '2024-09-26', gravity: 1.02, tempC: 18.2, brix: 5.1 },
  { id: 'r-011', batchId: 'b-003', date: '2024-10-05', gravity: 0.994, tempC: 16.5, brix: -1.5 }
]

const OPERATIONS: Array<Omit<OperationRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'op-001', batchId: 'b-001', type: '压帽', date: '2024-09-13', durationMin: 30, operator: '陈岩', state: '已完成', seq: 1 },
  { id: 'op-002', batchId: 'b-001', type: '淋皮', date: '2024-09-14', durationMin: 25, operator: '陈岩', state: '已完成', seq: 2 },
  { id: 'op-003', batchId: 'b-001', type: '倒罐', date: '2024-09-18', durationMin: 55, operator: '林沐', state: '已完成', seq: 3 },
  { id: 'op-004', batchId: 'b-001', type: '倒罐', date: '2024-09-26', durationMin: 50, operator: '林沐', state: '计划', seq: 4 },
  { id: 'op-005', batchId: 'b-002', type: '压帽', date: '2024-09-16', durationMin: 30, operator: '周亦', state: '已完成', seq: 1 },
  { id: 'op-006', batchId: 'b-002', type: '倒罐', date: '2024-09-21', durationMin: 60, operator: '周亦', state: '已完成', seq: 2 },
  { id: 'op-007', batchId: 'b-002', type: '淋皮', date: '2024-09-24', durationMin: 20, operator: '许澜', state: '计划', seq: 3 },
  { id: 'op-008', batchId: 'b-003', type: '倒罐', date: '2024-09-28', durationMin: 45, operator: '许澜', state: '已完成', seq: 1 }
]

const MLFS: Array<Omit<MlfRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'mlf-001', batchId: 'b-001', startDate: '', endDate: '', malicG: 2.4, state: '未启动' },
  { id: 'mlf-002', batchId: 'b-002', startDate: '2024-09-26', endDate: '', malicG: 0.9, state: '进行中' },
  { id: 'mlf-003', batchId: 'b-003', startDate: '2024-09-29', endDate: '2024-10-06', malicG: 0.2, state: '已完成' }
]

const TASTINGS: Array<Omit<TastingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'ts-001',
    batchId: 'b-001',
    date: '2024-09-19',
    aroma: '黑醋栗与青椒，果香集中',
    tannin: '单宁紧实，收口略涩',
    acidity: '酸度中高，骨架清晰',
    verdict: '待定'
  },
  {
    id: 'ts-002',
    batchId: 'b-002',
    date: '2024-09-28',
    aroma: '李子与雪松，带轻微还原味',
    tannin: '单宁柔顺',
    acidity: '酸度偏低，需补酸',
    verdict: '需调配'
  },
  {
    id: 'ts-003',
    batchId: 'b-003',
    date: '2024-10-08',
    aroma: '白桃与柠檬皮，香气干净',
    tannin: '几乎无单宁',
    acidity: '酸度明亮，平衡良好',
    verdict: '可直接装瓶'
  }
]

/** 清洗放行演示：已消费（在罐）/ 已放行（可分配）/ 清洗中（冲洗未达标）/ 出罐后已消费的历史记录。
 *  显式给出 createdAt/updatedAt：同一罐存在多条历史记录时，「最新记录」按创建时间判定，必须稳定。 */
const CLEANINGS: Array<Omit<CleaningRow, 'revision'>> = [
  {
    id: 'cl-001',
    tankId: 'tk-001',
    fromBatchId: null,
    toBatchId: 'b-001',
    state: '已消费',
    releasedAt: '2024-09-10T08:30:00.000Z',
    createdAt: Date.parse('2024-09-09T09:00:00.000Z'),
    updatedAt: Date.parse('2024-09-12T08:00:00.000Z'),
    steps: [
      { step: '碱洗', value: 2.2, passed: true, operator: '陈岩', recordedAt: '2024-09-09T09:00:00.000Z', invalidated: false },
      { step: '消毒', value: 120, passed: true, operator: '陈岩', recordedAt: '2024-09-09T11:00:00.000Z', invalidated: false },
      { step: '冲洗', value: 7.1, passed: true, operator: '林沐', recordedAt: '2024-09-10T08:30:00.000Z', invalidated: false }
    ]
  },
  {
    id: 'cl-002',
    tankId: 'tk-002',
    fromBatchId: null,
    toBatchId: 'b-002',
    state: '已消费',
    releasedAt: '2024-09-13T10:00:00.000Z',
    createdAt: Date.parse('2024-09-12T09:30:00.000Z'),
    updatedAt: Date.parse('2024-09-15T08:00:00.000Z'),
    steps: [
      { step: '碱洗', value: 2.0, passed: true, operator: '周亦', recordedAt: '2024-09-12T09:30:00.000Z', invalidated: false },
      { step: '消毒', value: 100, passed: true, operator: '周亦', recordedAt: '2024-09-12T14:00:00.000Z', invalidated: false },
      { step: '冲洗', value: 7.4, passed: true, operator: '许澜', recordedAt: '2024-09-13T10:00:00.000Z', invalidated: false }
    ]
  },
  {
    id: 'cl-003',
    tankId: 'tk-003',
    fromBatchId: 'b-003',
    toBatchId: null,
    state: '已放行',
    releasedAt: '2024-10-10T09:00:00.000Z',
    createdAt: Date.parse('2024-10-09T08:40:00.000Z'),
    updatedAt: Date.parse('2024-10-10T09:00:00.000Z'),
    steps: [
      { step: '碱洗', value: 2.5, passed: true, operator: '林沐', recordedAt: '2024-10-09T08:40:00.000Z', invalidated: false },
      { step: '消毒', value: 150, passed: true, operator: '林沐', recordedAt: '2024-10-09T13:20:00.000Z', invalidated: false },
      { step: '冲洗', value: 7.0, passed: true, operator: '陈岩', recordedAt: '2024-10-10T09:00:00.000Z', invalidated: false }
    ]
  },
  {
    id: 'cl-004',
    tankId: 'tk-004',
    fromBatchId: null,
    toBatchId: null,
    state: '清洗中',
    releasedAt: null,
    createdAt: Date.parse('2024-10-11T09:10:00.000Z'),
    updatedAt: Date.parse('2024-10-12T16:00:00.000Z'),
    steps: [
      { step: '碱洗', value: 2.8, passed: true, operator: '周亦', recordedAt: '2024-10-11T09:10:00.000Z', invalidated: false },
      { step: '消毒', value: 110, passed: true, operator: '周亦', recordedAt: '2024-10-11T11:30:00.000Z', invalidated: false },
      { step: '冲洗', value: 9.2, passed: false, operator: '许澜', recordedAt: '2024-10-12T16:00:00.000Z', invalidated: false }
    ]
  },
  {
    id: 'cl-005',
    tankId: 'tk-003',
    fromBatchId: null,
    toBatchId: 'b-003',
    state: '已消费',
    releasedAt: '2024-09-19T08:00:00.000Z',
    createdAt: Date.parse('2024-09-18T09:00:00.000Z'),
    updatedAt: Date.parse('2024-09-20T08:00:00.000Z'),
    steps: [
      { step: '碱洗', value: 1.8, passed: true, operator: '陈岩', recordedAt: '2024-09-18T09:00:00.000Z', invalidated: false },
      { step: '消毒', value: 90, passed: true, operator: '陈岩', recordedAt: '2024-09-18T15:00:00.000Z', invalidated: false },
      { step: '冲洗', value: 7.6, passed: true, operator: '林沐', recordedAt: '2024-09-19T08:00:00.000Z', invalidated: false }
    ]
  }
]

/** 灌入演示数据（地块 → 罐 → 批次 → 读数/作业/苹乳/品评/清洗放行） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.parcels, db.tanks, db.batches, db.readings, db.operations, db.mlfs, db.tastings, db.cleanings],
    async () => {
      await db.parcels.bulkPut(PARCELS.map(rev))
      await db.tanks.bulkPut(TANKS.map(rev))
      await db.batches.bulkPut(BATCHES.map(rev))
      await db.readings.bulkPut(READINGS.map(rev))
      await db.operations.bulkPut(OPERATIONS.map(rev))
      await db.mlfs.bulkPut(MLFS.map(rev))
      await db.tastings.bulkPut(TASTINGS.map(rev))
      await db.cleanings.bulkPut(CLEANINGS.map((row) => ({ ...row, revision: ROW_REVISION })))
    }
  )
}
