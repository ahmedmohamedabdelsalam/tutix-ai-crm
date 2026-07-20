import { splitIntoMessages } from './message-splitter'

export async function metaPost(phoneId: string, token: string, body: object): Promise<void> {
  await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Returns wamid of the first part sent (for Phase B reply-quoting); null on failure.
// contextMsgId, if provided, is attached as context.message_id to the first part only.
export async function sendWhatsAppMessage(
  phoneId: string,
  token: string,
  to: string,
  text: string,
  contextMsgId?: string,
): Promise<string | null> {
  const parts = splitIntoMessages(text)
  let firstWamid: string | null = null
  for (let pi = 0; pi < parts.length; pi++) {
    await new Promise(r => setTimeout(r, 5000))
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: parts[pi] },
    }
    if (pi === 0 && contextMsgId) body.context = { message_id: contextMsgId }
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      if (pi === 0) {
        const data = await res.json() as { messages?: { id: string }[] }
        firstWamid = data.messages?.[0]?.id ?? null
      }
    } else {
      const errText = await res.text()
      console.error(`Meta API error part ${pi + 1}/${parts.length} to=${to} status=${res.status}:`, errText)
    }
  }
  return firstWamid
}
