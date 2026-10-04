import type { Artifact, Relation, Stratum, Trench } from './index'

/** 封存版本号：同一探方内从 1 递增 */
export type SealedVersionNo = number

/** 封存快照：探方、地层单位、出土物、层位关系一并冻结 */
export interface SealedSnapshot {
  /** 封存时的探方本体（含回填标记） */
  trench: Trench
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** 封存版本（封存后只读，复勘只能基于它开新草稿） */
export interface SealedVersion {
  id: string
  /** 冗余字段，便于按探方索引与查询 */
  trenchId: string
  /** 版本号，同一探方内从 1 递增 */
  versionNo: SealedVersionNo
  /** 封存时间 ISO 字符串 */
  sealedAt: string
  /** 封存/复勘确认人 */
  sealedBy: string
  /** 版本说明：回填封存 / 复勘说明 */
  note: string
  /** 冻结的档案内容 */
  snapshot: SealedSnapshot
}

/** 复勘草稿（从封存版本 fork，工作副本可反复修改，提交后生成新版本） */
export interface ReworkDraft {
  id: string
  trenchId: string
  /** 草稿所依据（fork / 变基）的封存版本号 */
  baseVersionNo: SealedVersionNo
  /** 草稿最近一次打开基底的版本号（打开时的 head，用于进入工作台时提示） */
  openedVersionNo: SealedVersionNo
  createdAt: string
  updatedAt: string
  /** 发起复勘人 */
  createdBy: string
  /** 复勘事由 */
  reason: string
  /** 工作副本 */
  work: SealedSnapshot
}
