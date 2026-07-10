// Appends a provisional-date disclaimer whenever the reply mentions Hajj 1448H
// dates. The LLM strips "تقريباً" from catalog text, so this is enforced here.
export function applyHajjDateDisclaimer(reply: string): string {
  const mentionsHajj1448 =
    reply.includes('ذي الحجة ١٤٤٨') ||
    (reply.includes('ذي الحجة') && /٢٠٢٧/.test(reply))
  if (!mentionsHajj1448) return reply
  const disclaimer =
    'ملاحظة: التواريخ الهجرية لبرامج الحج ١٤٤٨هـ تقديرية بناءً على الحساب الفلكي وسيُعلن الرسمي منها بعد رؤية الهلال قبل الموسم بأسابيع'
  return `${reply}\n\n${disclaimer}`
}
