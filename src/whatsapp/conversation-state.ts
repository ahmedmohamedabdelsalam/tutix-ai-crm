export interface FullDetailsState {
  offset: number
  total: number
}

export interface OverviewState {
  orderedDetails: string[]  // pre-rendered detail strings, index 0 = item ١ in the overview
}

export const fullDetailsMap = new Map<string, FullDetailsState>()
export const overviewMap    = new Map<string, OverviewState>()
