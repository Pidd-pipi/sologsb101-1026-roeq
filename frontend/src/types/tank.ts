/** 罐体材质 */
export type TankMaterial = '不锈钢' | '橡木' | '混凝土'
/** 温控方式 */
export type TankTempControl = '夹套' | '盘管' | '无'
/** 罐位状态：在用 →（出罐）→ 待清洗 →（记录清洗步骤）→ 清洗中 →（三步达标放行）→ 空闲 →（入罐）→ 在用 */
export type TankState = '空闲' | '在用' | '待清洗' | '清洗中'

/** 发酵罐：容量配置与罐位占用 */
export interface Tank {
  id: string
  /** 罐号 */
  code: string
  /** 材质 */
  material: TankMaterial
  /** 容量（L） */
  capacityL: number
  /** 温控方式 */
  tempControl: TankTempControl
  /**
   * 罐位状态（由出罐 / 清洗放行 / 入罐流程自动驱动，不允许手工直接改写）：
   * 空闲 = 清洗已放行可分配；待清洗 = 出罐后尚未记录清洗；清洗中 = 已记录步骤但未放行
   */
  state: TankState
}

/** 罐位占用信息：分配批次时用于冲突校验 */
export interface TankOccupancy {
  tankId: string
  /** 当前占用该罐的在罐批次 id */
  batchId: string | null
  /** 占用批次的可读描述 */
  batchLabel: string | null
}

export const TANK_MATERIALS: TankMaterial[] = ['不锈钢', '橡木', '混凝土']
export const TANK_TEMP_CONTROLS: TankTempControl[] = ['夹套', '盘管', '无']
export const TANK_STATES: TankState[] = ['空闲', '在用', '待清洗', '清洗中']

/** 新罐建档表单：状态固定由系统置为「待清洗」，完成清洗放行后才可分配 */
export function createEmptyTank(): Omit<Tank, 'id' | 'state'> {
  return { code: '', material: '不锈钢', capacityL: 1000, tempControl: '夹套' }
}
