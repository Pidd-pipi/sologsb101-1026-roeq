/**
 * 首次打开应用时灌入的演示数据
 * 只在 parcels 表为空时执行，地块 → 发酵罐 → 批次 → 读数/作业/苹乳/品评 三层互相引用，
 * 并补齐「出罐 → 清洗放行 → 入罐」追溯链，保证每个页面第一次进入都有可点通的内容。
 * 函数本身幂等：由调用方判定表是否为空。
 */
import type {
  ParcelRow,
  TankRow,
  BatchRow,
  ReadingRow,
  OperationRow,
  MlfRow,
  TastingRow,
  CleaningRow
} from './db'
import type { CleaningStep } from '../types/cleaning'
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
  { id: 'tk-003', code: 'F-03', material: '不锈钢', capacityL: 1500, tempControl: '盘管', state: '在用' },
  { id: 'tk-004', code: 'F-04', material: '混凝土', capacityL: 5000, tempControl: '夹套', state: '清洗中' },
  { id: 'tk-005', code: 'F-05', material: '不锈钢', capacityL: 2000, tempControl: '夹套', state: '待清洗' }
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
    lastOperationAt: '2024-09-27T14:05:00.000Z'
  },
  {
    // 已出罐：tankId 保留历史罐位，档案可追溯出罐与入罐两端的清洗放行单
    id: 'b-003',
    parcelId: 'p-003',
    tankId: 'tk-003',
    harvestDate: '2024-09-05',
    volumeL: 1400,
    brix: 21.5,
    state: '已出罐',
    lastOperationAt: '2024-09-22T08:40:00.000Z'
  },
  {
    // 霞多丽第二批次：F-03 出罐清洗放行后入罐占用
    id: 'b-004',
    parcelId: 'p-003',
    tankId: 'tk-003',
    harvestDate: '2024-09-25',
    volumeL: 1350,
    brix: 22,
    state: '酒精发酵',
    lastOperationAt: null
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
  { id: 'r-009', batchId: 'b-003', date: '2024-09-05', gravity: 1.09, tempC: 19.8, brix: 21.5 },
  { id: 'r-010', batchId: 'b-003', date: '2024-09-12', gravity: 1.02, tempC: 18.2, brix: 5.1 },
  { id: 'r-011', batchId: 'b-003', date: '2024-09-20', gravity: 0.994, tempC: 16.5, brix: -1.5 },
  { id: 'r-012', batchId: 'b-004', date: '2024-09-25', gravity: 1.088, tempC: 20.2, brix: 22 },
  { id: 'r-013', batchId: 'b-004', date: '2024-09-28', gravity: 1.061, tempC: 21.8, brix: 15.2 }
]

const OPERATIONS: Array<Omit<OperationRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'op-001', batchId: 'b-001', type: '压帽', date: '2024-09-13', durationMin: 30, operator: '陈岩', state: '已完成', seq: 1 },
  { id: 'op-002', batchId: 'b-001', type: '淋皮', date: '2024-09-14', durationMin: 25, operator: '陈岩', state: '已完成', seq: 2 },
  { id: 'op-003', batchId: 'b-001', type: '倒罐', date: '2024-09-18', durationMin: 55, operator: '林沐', state: '已完成', seq: 3 },
  { id: 'op-004', batchId: 'b-001', type: '倒罐', date: '2024-09-26', durationMin: 50, operator: '林沐', state: '计划', seq: 4 },
  { id: 'op-005', batchId: 'b-002', type: '压帽', date: '2024-09-16', durationMin: 30, operator: '周亦', state: '已完成', seq: 1 },
  { id: 'op-006', batchId: 'b-002', type: '倒罐', date: '2024-09-21', durationMin: 60, operator: '周亦', state: '已完成', seq: 2 },
  { id: 'op-007', batchId: 'b-002', type: '淋皮', date: '2024-09-24', durationMin: 20, operator: '许澜', state: '计划', seq: 3 },
  { id: 'op-008', batchId: 'b-003', type: '倒罐', date: '2024-09-18', durationMin: 45, operator: '许澜', state: '已完成', seq: 1 }
]

const MLFS: Array<Omit<MlfRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'mlf-001', batchId: 'b-001', startDate: '', endDate: '', malicG: 2.4, state: '未启动' },
  { id: 'mlf-002', batchId: 'b-002', startDate: '2024-09-26', endDate: '', malicG: 0.9, state: '进行中' },
  { id: 'mlf-003', batchId: 'b-003', startDate: '2024-09-19', endDate: '2024-09-24', malicG: 0.2, state: '已完成' }
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
    date: '2024-09-22',
    aroma: '白桃与柠檬皮，香气干净',
    tannin: '几乎无单宁',
    acidity: '酸度明亮，平衡良好',
    verdict: '可直接装瓶'
  }
]

function step(
  kind: CleaningStep['kind'],
  state: CleaningStep['state'],
  value: number | null,
  operator: string,
  recordedAt: string,
  invalidatedAt: string | null = null
): CleaningStep {
  return { kind, state, value, operator, recordedAt, invalidatedAt }
}

/**
 * 清洗放行演示链：
 * - cln-001：F-03 上一批次 b-003 出罐后三步合格放行，已被 b-004 入罐占用；
 * - cln-002：F-04 碱洗 / 消毒已合格，冲洗值不合格，停在清洗中；
 * - cln-003：F-05 碱洗合格后被更正浓度，消毒 / 冲洗连带失效，演示「清洗值变化后续立即失效」；
 * - cln-004 / cln-005：F-01 / F-02 当前在罐批次入罐时占用的放行单。
 */
const CLEANINGS: Array<Omit<CleaningRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'cln-001',
    tankId: 'tk-003',
    fromBatchId: 'b-003',
    occupiedByBatchId: 'b-004',
    state: '已占用',
    steps: [
      step('碱洗', '合格', 2.0, '许澜', '2024-09-23T01:10:00.000Z'),
      step('消毒', '合格', 85, '许澜', '2024-09-23T02:40:00.000Z'),
      step('冲洗', '合格', 7.0, '周亦', '2024-09-23T04:05:00.000Z')
    ],
    releasedAt: '2024-09-23T04:10:00.000Z',
    occupiedAt: '2024-09-25T03:30:00.000Z',
    note: ''
  },
  {
    id: 'cln-002',
    tankId: 'tk-004',
    fromBatchId: null,
    occupiedByBatchId: null,
    state: '清洗中',
    steps: [
      step('碱洗', '合格', 1.8, '林沐', '2024-09-29T01:00:00.000Z'),
      step('消毒', '合格', 84.5, '林沐', '2024-09-29T02:30:00.000Z'),
      step('冲洗', '不合格', 8.2, '林沐', '2024-09-29T03:50:00.000Z')
    ],
    releasedAt: null,
    occupiedAt: null,
    note: '冲洗 pH 偏高，需重新冲洗至 6.5 ~ 7.5'
  },
  {
    id: 'cln-003',
    tankId: 'tk-005',
    fromBatchId: null,
    occupiedByBatchId: null,
    state: '清洗中',
    steps: [
      step('碱洗', '失效', 1.2, '陈岩', '2024-09-30T00:40:00.000Z', '2024-09-30T05:20:00.000Z'),
      step('消毒', '失效', 85, '陈岩', '2024-09-30T02:10:00.000Z', '2024-09-30T05:20:00.000Z'),
      step('冲洗', '失效', 7.1, '周亦', '2024-09-30T03:30:00.000Z', '2024-09-30T05:20:00.000Z'),
      step('碱洗', '合格', 2.1, '林沐', '2024-09-30T05:20:00.000Z')
    ],
    releasedAt: null,
    occupiedAt: null,
    note: '复核发现首遍碱洗浓度不足，更正后消毒、冲洗需重做'
  },
  {
    id: 'cln-004',
    tankId: 'tk-001',
    fromBatchId: null,
    occupiedByBatchId: 'b-001',
    state: '已占用',
    steps: [
      step('碱洗', '合格', 2.1, '林沐', '2024-09-11T01:30:00.000Z'),
      step('消毒', '合格', 86, '林沐', '2024-09-11T03:00:00.000Z'),
      step('冲洗', '合格', 7.1, '陈岩', '2024-09-11T04:20:00.000Z')
    ],
    releasedAt: '2024-09-11T04:30:00.000Z',
    occupiedAt: '2024-09-12T02:00:00.000Z',
    note: ''
  },
  {
    id: 'cln-005',
    tankId: 'tk-002',
    fromBatchId: null,
    occupiedByBatchId: 'b-002',
    state: '已占用',
    steps: [
      step('碱洗', '合格', 1.9, '周亦', '2024-09-14T00:50:00.000Z'),
      step('消毒', '合格', 84, '周亦', '2024-09-14T02:20:00.000Z'),
      step('冲洗', '合格', 6.9, '许澜', '2024-09-14T03:40:00.000Z')
    ],
    releasedAt: '2024-09-14T03:45:00.000Z',
    occupiedAt: '2024-09-15T02:30:00.000Z',
    note: ''
  }
]

/** 灌入演示数据（地块 → 罐 → 批次 → 读数/作业/苹乳/品评 + 清洗放行链） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.parcels,
      db.tanks,
      db.batches,
      db.readings,
      db.operations,
      db.mlfs,
      db.tastings,
      db.cleanings
    ],
    async () => {
      await db.parcels.bulkPut(PARCELS.map(rev))
      await db.tanks.bulkPut(TANKS.map(rev))
      await db.batches.bulkPut(BATCHES.map(rev))
      await db.readings.bulkPut(READINGS.map(rev))
      await db.operations.bulkPut(OPERATIONS.map(rev))
      await db.mlfs.bulkPut(MLFS.map(rev))
      await db.tastings.bulkPut(TASTINGS.map(rev))
      await db.cleanings.bulkPut(CLEANINGS.map(rev))
    }
  )
}
