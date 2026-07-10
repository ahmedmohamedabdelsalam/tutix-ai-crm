// Returns true only when the conversation's own messages mention companion or group context.
// Used to gate cross-session Lead facts (groupSize, companionNote) from being injected
// as "confirmed" context when the customer has said nothing about companions in this session.
export function companionConfirmedInHistory(messages: { content: string }[]): boolean {
  const text = messages.map(m => m.content).join(' ')
  return /والد|زوج|مراتي|مراته|أهل|معايا|أنا\s+و/.test(text)
}

// Returns true only when the conversation's own messages mention a travel month or date.
// Used to gate cross-session Lead.travelDate from being injected as "confirmed" context
// when the customer has not stated a month in this session.
export function travelDateConfirmedInHistory(messages: { content: string }[]): boolean {
  const text = messages.map(m => m.content).join(' ')
  return /يوليو|اغسطس|أغسطس|سبتمبر|اكتوبر|أكتوبر|نوفمبر|رمضان|مايو|يونيو|شهر/.test(text)
}
