import { PrismaService } from '../prisma/prisma.service'
import { splitIntoMessages } from './message-splitter'

// Save each WhatsApp-split part as its own Message record so the dashboard
// shows the same number of bubbles the customer sees on their phone.
/**
 * Persist an assistant reply and return the created row IDs, ONE PER PART.
 *
 * The ids are the whole point. This function splits with the same splitIntoMessages
 * that sendWhatsAppMessage uses, so row[i] and Meta message[i] are the same message —
 * and returning the ids lets the caller stamp each row with its OWN wamid instead of
 * guessing which rows a send belongs to.
 *
 * The guess is what used to happen: the caller re-queried "recent ASSISTANT rows with
 * no wamid" and zipped them positionally against one wamid per reply. A 3-part reply
 * created 3 rows and captured 1 wamid, so parts 2 and 3 were permanently unstampable —
 * which is most of the gap between this path's coverage and the inbound path's 99.9%.
 */
export async function saveAssistantMessage(prisma: PrismaService, conversationId: string, content: string): Promise<string[]> {
  const parts = splitIntoMessages(content)
  const baseTs = new Date()
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const row = await prisma.message.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        content: parts[i],
        createdAt: new Date(baseTs.getTime() + i * 200),
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  // Bump conversation.updatedAt so the inbox list re-sorts by latest activity
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
  return ids
}

export async function completeBookingAlert(
  prisma: PrismaService,
  convId: string,
  companyId: string,
  phone: string,
  reason: string,
  reply: string,
): Promise<void> {
  const lead = await prisma.lead.findFirst({
    where: { companyId, phone },
    select: { name: true },
  })
  const display = lead?.name ? `${lead.name} (${phone})` : phone
  const notifMsg = `عميل جاهز للدفع — يحتاج تواصل من فريق المبيعات: ${display}`
  await Promise.all([
    prisma.conversation.update({
      where: { id: convId },
      data: { needsSalesContact: true, salesAlertReason: reason, bookingStage: 'DONE' },
    }),
    prisma.systemNotification.create({
      data: { companyId, type: 'SALES_CONTACT_NEEDED', message: notifMsg },
    }),
  ])
  await saveAssistantMessage(prisma, convId, reply)
  console.log(`BOOKING_ALERT → ${phone} | reason=${reason}`)
}
