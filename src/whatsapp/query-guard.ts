/**
 * A lookup key must be a value, never an absence.
 *
 * Prisma treats the two absences very differently, and BOTH silently widen a query
 * rather than failing:
 *
 *   { phone: undefined }  →  the filter is DROPPED. The query matches every row the
 *                            remaining filters allow — for us, the whole company.
 *   { phone: null }       →  the filter becomes `phone IS NULL`. The query matches
 *                            every phone-LESS row, which is now a growing cohort.
 *
 * Neither throws. Neither logs. Both return a plausible-looking row belonging to
 * somebody else, and every caller downstream treats it as the right one.
 *
 * This became reachable the moment `phone` turned nullable (Phase 3a). Queries
 * written when a phone was guaranteed did not change shape — they just quietly
 * stopped meaning what they say. That is the same class as the hand-declared types
 * that disarmed `tsc`: the code still compiles and still reads correctly, and only
 * the data knows.
 *
 * So: if a value is being used to IDENTIFY one record, run it through here. If you
 * genuinely mean "the rows with no phone", write `phone: null` literally at the call
 * site, where a reader can see you meant it.
 */

/** Throws unless `value` is a real lookup key. Use where absence is a bug. */
export function requireLookupKey<T extends string | number>(
  value: T | null | undefined,
  field: string,
  ctx: string,
): T {
  if (value === undefined || value === null) {
    throw new Error(
      `[QUERY_WIDENING_BLOCKED] ${ctx}: refusing to query by ${field}=${String(value)}. ` +
      `Prisma would ${value === undefined ? 'DROP the filter and match the whole company'
                                          : 'match every row where ' + field + ' IS NULL'}, ` +
      `returning another customer's record. Guard the caller instead.`,
    )
  }
  return value
}

/**
 * The non-throwing form: null when there is no usable key.
 *
 * For paths that must keep going without one — a BSUID-only customer has no phone
 * and that is normal, not an error. Returning null forces the caller to write the
 * "no key" branch explicitly rather than letting a widened query invent an answer.
 */
export function optionalLookupKey<T extends string | number>(
  value: T | null | undefined,
): T | null {
  return value === undefined || value === null ? null : value
}
