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
