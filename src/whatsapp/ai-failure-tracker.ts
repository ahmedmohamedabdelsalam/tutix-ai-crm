const aiFailureCount = new Map<string, number>()

export function incrementAIFailure(convId: string): number {
  const fc = (aiFailureCount.get(convId) ?? 0) + 1
  aiFailureCount.set(convId, fc)
  return fc
}

export function resetAIFailure(convId: string): void {
  aiFailureCount.delete(convId)
}
