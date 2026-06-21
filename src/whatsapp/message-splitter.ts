/**
 * Splits a cleaned AI reply into the same parts that get sent as separate
 * WhatsApp messages.  Both the controller (for Meta API delivery) and the
 * service (for DB Message records) import from here so the two stay in sync.
 *
 * Rules:
 *   - Split first by blank lines (paragraph breaks)
 *   - Paragraphs containing ⭐ or 2+ "جنيه" = package card → one message
 *   - All other paragraphs → split further by single newlines
 */
export function splitIntoMessages(reply: string): string[] {
  const segments: string[] = []
  for (const para of reply.split(/\n\n+/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    const isPackageCard = trimmed.includes('⭐') || (trimmed.match(/جنيه/g) ?? []).length >= 2
    if (isPackageCard) {
      segments.push(trimmed)
    } else {
      for (const line of trimmed.split('\n')) {
        const l = line.trim()
        if (l) segments.push(l)
      }
    }
  }
  return segments
}
