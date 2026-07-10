import { PrismaService } from '../prisma/prisma.service'
import { splitIntoMessages } from './message-splitter'

// Save each WhatsApp-split part as its own Message record so the dashboard
// shows the same number of bubbles the customer sees on their phone.
export async function saveAssistantMessage(prisma: PrismaService, conversationId: string, content: string): Promise<void> {
  const parts = splitIntoMessages(content)
  const baseTs = new Date()
  for (let i = 0; i < parts.length; i++) {
    await prisma.message.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        content: parts[i],
        createdAt: new Date(baseTs.getTime() + i * 200),
      },
    })
  }
  // Bump conversation.updatedAt so the inbox list re-sorts by latest activity
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
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
