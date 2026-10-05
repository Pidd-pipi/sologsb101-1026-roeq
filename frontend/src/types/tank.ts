/** 罐体材质 */
export type TankMaterial = '不锈钢' | '橡木' | '混凝土'
/** 温控方式 */
export type TankTempControl = '夹套' | '盘管' | '无'
/** 罐位状态：出罐后先进入「待清洗」，清洗放行后才可再次分配 */
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
  /** 罐位状态（由最新清洗放行单派生） */
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
/** 看板与筛选使用的全部罐位状态（顺序即看板展示顺序） */
export const TANK_STATES: TankState[] = ['空闲', '在用', '待清洗', '清洗中']

export function createEmptyTank(): Omit<Tank, 'id'> {
  return { code: '', material: '不锈钢', capacityL: 1000, tempControl: '夹套', state: '待清洗' }
}
