import { WhatsAppController } from './whatsapp.controller'

// Minimal mocks — only what the unknown-waPhoneId path touches
const mockPrisma = {
  company: { findFirst: jest.fn() },
  conversation: { findFirst: jest.fn() },
  message: { create: jest.fn() },
  lead: { findFirst: jest.fn(), create: jest.fn() },
}

const mockWhatsApp = { handleMessage: jest.fn() }
const mockFollowup = {}

function makeRes() {
  const res = { status: jest.fn(), send: jest.fn() } as any
  res.status.mockReturnValue(res)
  return res
}

function makeWebhookBody(phoneNumberId: string, fromNumber = '201001234567') {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: phoneNumberId },
          messages: [{
            from: fromNumber,
            id: 'wamid.test123',
            type: 'text',
            text: { body: 'عايز أعرف عن العمرة' },
          }],
        },
      }],
    }],
  }
}

describe('WhatsAppController — unknown waPhoneId', () => {
  let controller: WhatsAppController
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    controller = new WhatsAppController(
      mockWhatsApp as any,
      mockFollowup as any,
      mockPrisma as any,
    )
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns 200, logs warning, and creates no DB records for an unregistered phone id', async () => {
    const UNKNOWN_ID = 'phone_id_not_in_db'
    mockPrisma.company.findFirst.mockResolvedValue(null)

    const res = makeRes()
    await controller.receive(makeWebhookBody(UNKNOWN_ID), res)

    // Must return 200 so Meta stops retrying
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith('OK')

    // Must warn with the unknown phone id
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(UNKNOWN_ID),
    )
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('message ignored'),
    )

    // Must NOT touch any DB or AI after the unknown-id guard
    expect(mockPrisma.conversation.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.message.create).not.toHaveBeenCalled()
    expect(mockPrisma.lead.create).not.toHaveBeenCalled()
    expect(mockWhatsApp.handleMessage).not.toHaveBeenCalled()
  })
})
