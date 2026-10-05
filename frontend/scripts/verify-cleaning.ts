/**
 * 清洗放行链路端到端验证（node + fake-indexeddb）：
 * 1. 出罐 → 待清洗 + 新放行单；
 * 2. 顺序记录：碱洗/消毒合格后才能录冲洗，不合格不放行；
 * 3. 更正清洗值 → 后续步骤立即失效；
 * 4. 三步合格 → 已放行（罐位空闲），批次档案可查到入罐放行凭据；
 * 5. 两个「标签页」同时对同一已放行罐位提交入罐 → 只成功一方；
 * 6. 出罐旧批次再入新批次形成完整追溯链；
 * 7. v1 → v2 迁移：缺放行记录的非在用罐 → 待清洗 + 补开单据；在用罐补占用单。
 */
import 'fake-indexeddb/auto'

async function main(): Promise<void> {
  // ---------- v1 老库构造 ----------
  const { default: Dexie } = await import('dexie')
  const oldDb = new Dexie('gbwinetank-db')
  oldDb.version(1).stores({
    parcels: 'id',
    tanks: 'id, state',
    batches: 'id, parcelId, tankId, state',
    readings: 'id, batchId',
    operations: 'id, batchId',
    mlfs: 'id, batchId',
    tastings: 'id, batchId'
  })
  await oldDb.open()
  await oldDb.table('parcels').bulkPut([{ id: 'p1', name: '东地', variety: '赤霞珠', areaMu: 1, vineAge: 1, aspect: '南' }])
  await oldDb.table('tanks').bulkPut([
    { id: 't1', code: 'F-01', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '空闲' },
    { id: 't2', code: 'F-02', material: '不锈钢', capacityL: 2000, tempControl: '夹套', state: '在用' },
    { id: 't3', code: 'F-03', material: '橡木', capacityL: 500, tempControl: '无', state: '清洗中' }
  ])
  await oldDb.table('batches').bulkPut([
    { id: 'b1', parcelId: 'p1', tankId: 't2', harvestDate: '2024-09-01', volumeL: 100, brix: 22, state: '酒精发酵', lastOperationAt: null }
  ])
  await oldDb.close()

  // ---------- 打开 v2（触发升级） ----------
  const v2 = await import('../src/utils/db.ts')
  await v2.initDatabase() // 演示数据不会播种（parcels 非空）
  {
    const tanks = await v2.listTanks()
    const map = new Map(tanks.map((t) => [t.id, t.state]))
    assert(map.get('t1') === '待清洗', `v1 空闲罐升级应为待清洗，实际 ${map.get('t1')}`)
    assert(map.get('t2') === '在用', `v1 在用罐升级应保持在用，实际 ${map.get('t2')}`)
    assert(map.get('t3') === '待清洗', `v1 清洗中罐(无放行记录)升级应为待清洗，实际 ${map.get('t3')}`)
    const cleans = await v2.listCleanings()
    const t1c = cleans.find((c) => c.tankId === 't1')
    const t2c = cleans.find((c) => c.tankId === 't2')
    assert(t1c?.state === '待清洗' && t1c.note.includes('旧数据升级'), 't1 应补开待清洗放行单')
    assert(t2c?.state === '已占用' && t2c.occupiedByBatchId === 'b1', 't2 应补建已占用放行单')
    console.log('✓ v1→v2 迁移：缺记录罐位待清洗，在用罐补占用单')
  }

  // ---------- 入罐门槛：未放行不可入 ----------
  const { ROW_REVISION } = v2
  await assertRejects(
    () =>
      v2.createBatchAssigned({
        id: 'bx1', parcelId: 'p1', tankId: 't1', harvestDate: '2024-10-01', volumeL: 100, brix: 22,
        state: '酒精发酵', lastOperationAt: null, revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now()
      }),
    v2.TankGateError,
    '未完成清洗放行不能入罐'
  )
  console.log('✓ 入罐门槛：待清洗罐位被拒绝')

  // ---------- 顺序记录 + 不合格 + 更正失效链 ----------
  const t1Latest = (await v2.listCleanings()).find((c) => c.tankId === 't1')!
  // 消毒不能先于碱洗
  await assertRejects(() => v2.recordCleaningStep(t1Latest.id, '消毒', 85, '甲'), Error, '消毒不能先于碱洗')
  await v2.recordCleaningStep(t1Latest.id, '碱洗', 2.0, '甲')
  await v2.recordCleaningStep(t1Latest.id, '消毒', 85, '甲')
  // 冲洗不合格
  await v2.recordCleaningStep(t1Latest.id, '冲洗', 8.4, '甲')
  let afterFail = await v2.db.cleanings.get(t1Latest.id)
  assert(afterFail!.state === '清洗中', '冲洗不合格时单据应仍为清洗中')
  assert((await v2.db.tanks.get('t1'))!.state === '清洗中', '罐位应为清洗中')

  // 重新冲洗合格
  await v2.recordCleaningStep(t1Latest.id, '冲洗', 7.0, '甲')
  afterFail = await v2.db.cleanings.get(t1Latest.id)
  assert(afterFail!.state === '已放行' && !!afterFail!.releasedAt, '三步合格后应自动放行')
  assert((await v2.db.tanks.get('t1'))!.state === '空闲', '放行后罐位应为空闲')
  console.log('✓ 顺序记录 / 不合格不放行 / 合格自动放行')

  // 更正碱洗值 → 消毒、冲洗立即失效，旧值留痕
  await v2.recordCleaningStep(t1Latest.id, '碱洗', 1.8, '乙')
  const afterCorrect = await v2.db.cleanings.get(t1Latest.id)
  assert(afterCorrect!.state === '清洗中', '更正碱洗后单据打回清洗中')
  const disinfect = afterCorrect!.steps.filter((s) => s.kind === '消毒')
  const rinse = afterCorrect!.steps.filter((s) => s.kind === '冲洗')
  assert(disinfect.some((s) => s.state === '失效') && rinse.some((s) => s.state === '失效'), '消毒/冲洗应立即失效')
  assert(afterCorrect!.steps.filter((s) => s.kind === '碱洗').length === 2, '碱洗原值应留痕（共2条）')
  assert((await v2.db.tanks.get('t1'))!.state === '清洗中', '罐位应回到清洗中')
  // 新碱洗合格，重新走完消毒 / 冲洗后恢复放行
  await v2.recordCleaningStep(t1Latest.id, '消毒', 84, '乙')
  await v2.recordCleaningStep(t1Latest.id, '冲洗', 7.1, '乙')
  assert((await v2.db.cleanings.get(t1Latest.id))!.state === '已放行', '重做三步后应恢复已放行')
  console.log('✓ 清洗值更正：后续步骤立即失效并留痕')

  // ---------- 两个标签页同时入罐同一罐位 ----------
  const makeBatch = (id: string) => ({
    id, parcelId: 'p1', tankId: 't1', harvestDate: '2024-10-02', volumeL: 90, brix: 22,
    state: '酒精发酵' as const, lastOperationAt: null,
    revision: ROW_REVISION, createdAt: Date.now(), updatedAt: Date.now()
  })
  const results = await Promise.allSettled([v2.createBatchAssigned(makeBatch('bc1')), v2.createBatchAssigned(makeBatch('bc2'))])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert(fulfilled.length === 1 && rejected.length === 1, `并发入罐应一成一败，实际 ${fulfilled.length}/${rejected.length}`)
  const err = (rejected[0] as PromiseRejectedResult).reason
  assert(err instanceof v2.TankGateError, '失败方应收到 TankGateError')
  const occupant = await v2.db.batches.where('tankId').equals('t1').filter((b) => b.state !== '已出罐').toArray()
  assert(occupant.length === 1, `t1 只能有一个在罐批次，实际 ${occupant.length}`)
  assert((await v2.db.tanks.get('t1'))!.state === '在用', '罐位应为在用')
  console.log('✓ 跨标签页并发入罐：只一方占用，另一方被拒')

  // ---------- 出罐 → 待清洗 → 再放行 → 新批次入罐，档案追溯 ----------
  await v2.shipBatch(occupant[0].id)
  assert((await v2.db.tanks.get('t1'))!.state === '待清洗', '出罐后应立即待清洗')
  const newRel = await v2.getLatestCleaning('t1')
  assert(newRel!.fromBatchId === occupant[0].id && newRel!.state === '待清洗', '新放行单应记录来源批次')
  await v2.recordCleaningStep(newRel!.id, '碱洗', 2.2, '丙')
  await v2.recordCleaningStep(newRel!.id, '消毒', 86, '丙')
  await v2.recordCleaningStep(newRel!.id, '冲洗', 6.9, '丙')
  await v2.createBatchAssigned(makeBatch('bd1'))
  const gate = await v2.getCleaningByOccupant('bd1')
  assert(gate?.fromBatchId === occupant[0].id, '新批次档案应能追溯到上一批次与完整放行单')
  assert(gate!.steps.every((s) => s.state === '合格' || s.state === '失效'), '放行单步骤记录完整')
  console.log('✓ 出罐→清洗放行→入罐追溯链完整，批次档案含放行凭据')

  console.log('\n全部验证通过 ✅')
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${message}`)
}

async function assertRejects(
  fn: () => Promise<unknown>,
  errorCtor: new (...args: never[]) => Error,
  message: string
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    assert(err instanceof errorCtor, `${message}（错误类型不符：${String(err)}）`)
    return
  }
  throw new Error(`断言失败：${message}（未抛错）`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
