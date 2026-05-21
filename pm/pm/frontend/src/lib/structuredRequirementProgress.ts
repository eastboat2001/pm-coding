import type {
  RequirementCollectionStatus,
  StructuredRequirementModel,
} from '../types/structuredRequirement'

export type StructuredRequirementProgress = {
  totalCount: number
  confirmedCount: number
  collectedCount: number
  pendingConfirmationCount: number
  conflictCount: number
  collectionCoveragePercentage: number
  confirmationPercentage: number
  readyToGenerate: boolean
}

const REQUIREMENT_KEYS = [
  'objective',
  'scope',
  'users',
  'scenarios',
  'features',
  'pages',
  'rules',
  'integrations',
  'acceptance',
] as const

export function computeStructuredRequirementProgress(
  model: StructuredRequirementModel,
): StructuredRequirementProgress {
  const statuses = REQUIREMENT_KEYS.map((key) => model.collection_status[key].status)
  const totalCount = statuses.length
  const confirmedCount = countStatuses(statuses, 'confirmed')
  const collectedCount = statuses.filter((status) => status !== 'missing').length
  const pendingConfirmationCount = countStatuses(statuses, 'pending_confirmation')
  const conflictCount = countStatuses(statuses, 'conflict')
  const collectionCoveragePercentage = totalCount
    ? Math.round((collectedCount / totalCount) * 100)
    : 0
  const confirmationPercentage = totalCount
    ? Math.round((confirmedCount / totalCount) * 100)
    : 0

  return {
    totalCount,
    confirmedCount,
    collectedCount,
    pendingConfirmationCount,
    conflictCount,
    collectionCoveragePercentage,
    confirmationPercentage,
    readyToGenerate:
      totalCount > 0 &&
      collectionCoveragePercentage === 100 &&
      confirmationPercentage === 100,
  }
}

function countStatuses(
  statuses: RequirementCollectionStatus[],
  target: RequirementCollectionStatus,
): number {
  return statuses.filter((status) => status === target).length
}
