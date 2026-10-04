import type { Artifact, Relation, Stratum, Trench } from './index'

/** 封存版本：探方回填确认后冻结的不可变快照 */
export interface ArchiveVersion {
  id: string
  /** 探方 id */
  trenchId: string
  /** 版本号，同一探方内从 1 递增 */
  versionNo: number
  /** 所基于的上一封存版本 id（第一版为空） */
  parentId: string
  /** 封存时的探方记录（冻结副本） */
  trench: Trench
  /** 封存说明（回填确认 / 复勘改定要点） */
  note: string
  /** 封存时间 ISO 字符串 */
  createdAt: string
}

/** 封存快照行的公共字段：id 为「版本id:原行id」复合主键，originId 为业务原 id */
interface ArchiveRow {
  /** 复合主键 `${versionId}:${originId}` */
  id: string
  /** 业务原 id，跨版本比对时的稳定身份 */
  originId: string
  /** 所属封存版本 */
  versionId: string
  /** 冗余探方 id，便于索引 */
  trenchId: string
}

/** 封存快照中的地层单位行 */
export type ArchiveStratum = Omit<Stratum, 'id'> & ArchiveRow

/** 封存快照中的出土物行 */
export type ArchiveArtifact = Omit<Artifact, 'id'> & ArchiveRow

/** 封存快照中的层位关系行 */
export type ArchiveRelation = Omit<Relation, 'id'> & ArchiveRow

/** 复勘草稿状态 */
export type DraftStatus = 'open' | 'submitted' | 'discarded'

/**
 * 复勘草稿：从某一封存版本开启，编辑只落在草稿工作区。
 * 实体均为完整副本（含草稿新增行），以业务原 id 作为行键。
 */
export interface SurveyDraft {
  id: string
  trenchId: string
  /** 开启草稿时所基于的封存版本 id（乐观锁基底） */
  baseVersionId: string
  /** 基底版本号，便于展示 */
  baseVersionNo: number
  status: DraftStatus
  /** 草稿中的探方记录 */
  trench: Trench
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
  /** 开启时间 */
  createdAt: string
  /** 最近修改时间 */
  updatedAt: string
  /** 提交成功后生成的新版本 id（未提交为空） */
  submittedVersionId: string
  /** 放弃/提交原因备注 */
  note: string
}
