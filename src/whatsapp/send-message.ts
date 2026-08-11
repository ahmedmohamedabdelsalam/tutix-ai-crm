import { splitIntoMessages } from './message-splitter'
import { GRAPH_BASE } from './graph-api'
import { addressingFields, addressingMode, describeTarget, type SendTarget } from './recipient'

export async function metaPost(phoneId: string, token: string, body: object): Promise<void> {
  await fetch(`${GRAPH_BASE}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Send one image by its Meta media ID, with a caption.
 *
 * Returns true only when Meta accepted it. The caller sends the text either way —
 * an image that fails is an image the customer does not see, never a reply they do
 * not get. Same addressing rules as text, so a BSUID-only customer gets pictures too.
 */
export async function sendWhatsAppImage(
  phoneId: string,
  token: string,
  target: SendTarget,
  mediaId: string,
  caption: string,
): Promise<boolean> {
  const address = addressingFields(target)
  if (!address) {
    console.error('[SEND_UNADDRESSABLE] image not sent — no phone and no BSUID on this conversation.')
    return false
  }
  const res = await fetch(`${GRAPH_BASE}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...address,
      type: 'image',
      image: { id: mediaId, caption },
    }),
  })
  if (!res.ok) {
    console.error(
      `[IMAGE_SEND_FAILED] mode=${addressingMode(target)} ${describeTarget(target)} ` +
      `status=${res.status} — Meta said: ${await res.text()}`,
    )
    return false
  }
  console.log(`[IMAGE_SENT] ${describeTarget(target)} media=${mediaId}`)
  return true
}

/**
 * Send a text message, addressed by phone when we have one and by BSUID when we do
 * not. Returns the wamid of the first part (for reply-quoting), null on failure.
 *
 * FAILURE IS LOUD, DELIBERATELY. A sales rep pressing send and seeing nothing is
 * the exact failure Phase 3c exists to remove, so a rejection is never swallowed.
 * Every non-OK response logs the addressing mode and Meta's full body — "it didn't
 * arrive" now has two very different causes, and the first question will always be
 * which path the message took.
 */
export async function sendWhatsAppMessage(
  phoneId: string,
  token: string,
  target: SendTarget,
  text: string,
  contextMsgId?: string,
): Promise<string | null> {
  const address = addressingFields(target)
  if (!address) {
    // Not a Meta failure — we have no way to name this customer at all. Never
    // return quietly: silence here looks identical to a successful send.
    console.error(
      '[SEND_UNADDRESSABLE] refusing to send — no phone and no BSUID on this conversation. ' +
      'Nothing was delivered and no attempt was made.',
    )
    return null
  }
  const mode = addressingMode(target)

  const parts = splitIntoMessages(text)
  let firstWamid: string | null = null
  for (let pi = 0; pi < parts.length; pi++) {
    await new Promise(r => setTimeout(r, 5000))
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...address,
      type: 'text',
      text: { body: parts[pi] },
    }
    if (pi === 0 && contextMsgId) body.context = { message_id: contextMsgId }
    const res = await fetch(`${GRAPH_BASE}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      if (pi === 0) {
        const data = await res.json() as { messages?: { id: string }[] }
        firstWamid = data.messages?.[0]?.id ?? null
      }
      // Logged on success for BSUID sends specifically: "a message actually
      // delivered to a BSUID" is a claim this project has never been able to make,
      // and it should be visible the first time it becomes true.
      if (mode === 'recipient') {
        console.log(`[SEND_OK_RECIPIENT] part ${pi + 1}/${parts.length} accepted — ${describeTarget(target)} wamid=${firstWamid ?? 'n/a'}`)
      }
    } else {
      const errText = await res.text()
      console.error(
        `[SEND_FAILED] mode=${mode} ${describeTarget(target)} part ${pi + 1}/${parts.length} ` +
        `status=${res.status} — Meta said: ${errText}`,
      )
    }
  }
  return firstWamid
}
