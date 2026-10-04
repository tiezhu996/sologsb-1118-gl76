import type { SealedVersion } from '@/types'
import { downloadCsv, downloadJson } from '@/utils/export'

function versionTag(version: SealedVersion): string {
  const code = version.snapshot.trench.code
  return `${code}-封存第${version.versionNo}版`
}

/** 导出某一封存版本的完整 JSON 档案（探方 + 地层 + 出土物 + 关系） */
export function exportVersionJson(version: SealedVersion): void {
  downloadJson(
    `${versionTag(version)}_${version.sealedAt.slice(0, 10)}.json`,
    {
      kind: 'gbtrenchlog-sealed-version',
      trenchId: version.trenchId,
      versionNo: version.versionNo,
      sealedAt: version.sealedAt,
      sealedBy: version.sealedBy,
      note: version.note,
      snapshot: version.snapshot
    }
  )
}

/** 导出某一封存版本的四组 CSV（地层单位 / 出土物 / 层位关系 / 探方信息），合并为一个文本会破坏表头，这里分别导出 */
export function exportVersionCsv(version: SealedVersion): void {
  const { snapshot } = version
  const prefix = versionTag(version)
  const dateTag = version.sealedAt.slice(0, 10)

  downloadCsv(
    `${prefix}_地层单位_${dateTag}.csv`,
    snapshot.strata.map((item) => ({
      code: item.code,
      type: item.type,
      openLayer: item.openLayer,
      topDepth: item.topDepth,
      bottomDepth: item.bottomDepth,
      soil: item.soil,
      inclusions: item.inclusions.join('、'),
      formation: item.formation,
      date: item.date,
      drawingNo: item.drawingNo
    })) as unknown as Record<string, unknown>[],
    [
      { key: 'code', label: '单位号' },
      { key: 'type', label: '类型' },
      { key: 'openLayer', label: '开口层位' },
      { key: 'topDepth', label: '上界深度(m)' },
      { key: 'bottomDepth', label: '下界深度(m)' },
      { key: 'soil', label: '土质土色' },
      { key: 'inclusions', label: '包含物' },
      { key: 'formation', label: '堆积成因' },
      { key: 'date', label: '日期' },
      { key: 'drawingNo', label: '绘图拍照号' }
    ]
  )

  const unitCode = new Map(snapshot.strata.map((item) => [item.id, item.code]))
  downloadCsv(
    `${prefix}_出土物_${dateTag}.csv`,
    snapshot.artifacts.map((item) => ({
      code: item.code,
      stratum: unitCode.get(item.stratumId) ?? item.stratumId,
      category: item.category,
      count: item.count,
      completeness: item.completeness,
      x: item.x,
      y: item.y,
      z: item.z,
      date: item.date,
      collector: item.collector,
      tempLocation: item.tempLocation
    })) as unknown as Record<string, unknown>[],
    [
      { key: 'code', label: '器物编号' },
      { key: 'stratum', label: '地层单位' },
      { key: 'category', label: '类别' },
      { key: 'count', label: '件数' },
      { key: 'completeness', label: '残整程度' },
      { key: 'x', label: 'X(m)' },
      { key: 'y', label: 'Y(m)' },
      { key: 'z', label: 'Z深度(m)' },
      { key: 'date', label: '出土日期' },
      { key: 'collector', label: '提取人' },
      { key: 'tempLocation', label: '临时存放' }
    ]
  )

  downloadCsv(
    `${prefix}_层位关系_${dateTag}.csv`,
    snapshot.relations.map((item) => ({
      unitA: unitCode.get(item.unitAId) ?? item.unitAId,
      type: item.type,
      unitB: unitCode.get(item.unitBId) ?? item.unitBId,
      basis: item.basis,
      recorder: item.recorder,
      note: item.note
    })) as unknown as Record<string, unknown>[],
    [
      { key: 'unitA', label: '单位A' },
      { key: 'type', label: '关系' },
      { key: 'unitB', label: '单位B' },
      { key: 'basis', label: '判定依据' },
      { key: 'recorder', label: '记录人' },
      { key: 'note', label: '备注' }
    ]
  )
}
