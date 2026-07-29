export interface FullDetailsState {
  offset: number
  total: number
}

export interface RawTrip {
  depISO: string
  retISO: string
  progs: any[]
}

export interface OverviewState {
  orderedDetails: string[]  // pre-rendered detail strings, index 0 = item ١ in the overview
  rawTrips?: RawTrip[]      // parallel to orderedDetails; undefined for Hajj overviews
}

export const fullDetailsMap       = new Map<string, FullDetailsState>()
export const overviewMap          = new Map<string, OverviewState>()
export const categoryQuestionMap  = new Map<string, true>()
// Tracks consecutive no-handler/no-FAQ messages per conversation.
// Reset to 0 at the start of each message; overwritten to prevCount+1 only when
// the message falls through every deterministic handler and every FAQ.
// Reaching 2 triggers immediate handoff (repeat failure).
export const noMatchMap           = new Map<string, number>()
