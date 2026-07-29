// Scans model-generated text for fact-shaped content before it is sent.
// After the confidence layer, model output should only be social language
// (greetings, name requests, acknowledgements). Digits, Arabic month names,
// or catalog entity names (hotel brands, program names) signal a fact the
// model should never state.
// Returns the first offending token, or null if the text is clean.

// Builds the per-company entity blocklist from the prebuilt catalog.
// Includes hotel names, hotel keywords, and location/location-2 values from
// rawUmrahPrograms.  Call once per handleMessage — result is ephemeral, no cache.
// Accepts `any` to avoid a circular import with agent.service.ts.
export function buildEntityBlocklist(catalog: any): string[] {
  if (!catalog) return []
  const seen = new Set<string>()
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.length > 2) seen.add(s)
  }
  // hotelList: name + keywords array
  for (const h of catalog.hotelList ?? []) {
    add(h.name)
    for (const kw of h.keywords ?? []) add(kw)
  }
  // rawUmrahPrograms: location (mecca hotel) and location-2 (medina hotel) role values
  for (const p of catalog.rawUmrahPrograms ?? []) {
    add(p.makkahHotel ?? p.meccaHotel)
    add(p.madinahHotel ?? p.medinaHotel)
  }
  return [...seen]
}

export function scanModelOutput(text: string, entityBlocklist?: string[]): string | null {
  const digitMatch = text.match(/[٠١٢٣٤٥٦٧٨٩0-9]/)
  if (digitMatch) return `digit:${digitMatch[0]}`
  const monthMatch = text.match(/يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر|يناير|فبراير|مارس|أبريل|مايو|يونيو/)
  if (monthMatch) return `month:${monthMatch[0]}`
  // Entity blocklist: hotel brand names and program location values loaded per company from DB
  if (entityBlocklist) {
    for (const entity of entityBlocklist) {
      if (text.includes(entity)) return `entity:${entity.substring(0, 30)}`
    }
  }
  return null
}
