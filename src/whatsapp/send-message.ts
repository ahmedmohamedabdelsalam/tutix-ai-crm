import { splitIntoMessages } from './message-splitter'

export async function metaPost(phoneId: string, token: string, body: object): Promise<void> {
  await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function sendWhatsAppMessage(
  phoneId: string,
  token: string,
  to: string,
  text: string,
): Promise<void> {
  const parts = splitIntoMessages(text)
  for (let pi = 0; pi < parts.length; pi++) {
    await new Promise(r => setTimeout(r, 5000))
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: parts[pi] },
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error(`Meta API error part ${pi + 1}/${parts.length} to=${to} status=${res.status}:`, errText)
    }
  }
}
