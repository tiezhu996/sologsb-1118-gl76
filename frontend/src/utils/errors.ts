/** 探方已封存且没有进行中的复勘草稿：默认只读，禁止直接改动 */
export class TrenchFrozenError extends Error {
  readonly trenchId: string
  constructor(trenchId: string, message = '该探方已封存，页面为只读；请从封存版开启复勘草稿后再修改') {
    super(message)
    this.name = 'TrenchFrozenError'
    this.trenchId = trenchId
  }
}

/** 复勘草稿依据的基底封存版本已过期（其他标签页已提交过新版本） */
export class BaseStaleError extends Error {
  readonly trenchId: string
  /** 草稿原基底版本号 */
  readonly baseVersionNo: number
  /** 服务端（IndexedDB）当前最新版本号 */
  readonly latestVersionNo: number
  constructor(trenchId: string, baseVersionNo: number, latestVersionNo: number) {
    super(
      `基底已过期：本草稿基于第 ${baseVersionNo} 版，而第 ${latestVersionNo} 版已由其他记录员提交。草稿已保留，请先比对再变基重交`
    )
    this.name = 'BaseStaleError'
    this.trenchId = trenchId
    this.baseVersionNo = baseVersionNo
    this.latestVersionNo = latestVersionNo
  }
}

export function isTrenchFrozenError(error: unknown): error is TrenchFrozenError {
  return error instanceof TrenchFrozenError
}

export function isBaseStaleError(error: unknown): error is BaseStaleError {
  return error instanceof BaseStaleError
}
