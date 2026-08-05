import { createHmac } from 'crypto'
import { WhatsAppController } from './whatsapp.controller'

const TEST_APP_SECRET = 'test-app-secret-for-hmac'

/** Builds the (req, signature) pair the controller needs, signed like Meta signs it. */
function signed(body: unknown, secret = TEST_APP_SECRET) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
  return { req: { rawBody: raw } as any, signature }
}

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
    process.env.META_APP_SECRET = TEST_APP_SECRET
    // Start every test from the shipped default (warn mode); describes opt in.
    delete process.env.META_SIGNATURE_ENFORCE
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
    const body = makeWebhookBody(UNKNOWN_ID)
    const { req, signature } = signed(body)
    await controller.receive(body, res, req, signature)

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

  // ── X-Hub-Signature-256 verification (fail-closed) ────────────────────────
  const rejectionCases: Array<[string, () => { body: any; req: any; signature: string | undefined }]> = [
    ['an unsigned request', () => {
      const body = makeWebhookBody('any_id')
      return { body, req: { rawBody: Buffer.from(JSON.stringify(body)) }, signature: undefined }
    }],
    ['a signature from the wrong secret', () => {
      const body = makeWebhookBody('any_id')
      const { req, signature } = signed(body, 'attacker-guessed-secret')
      return { body, req, signature }
    }],
    ['a body tampered with after signing', () => {
      const original = makeWebhookBody('any_id')
      const { signature } = signed(original)
      const tampered = makeWebhookBody('attacker_id')
      return { body: tampered, req: { rawBody: Buffer.from(JSON.stringify(tampered)) }, signature }
    }],
  ]

  describe('ENFORCE mode (META_SIGNATURE_ENFORCE=true)', () => {
    beforeEach(() => { process.env.META_SIGNATURE_ENFORCE = 'true' })

    it.each(rejectionCases)('rejects %s with 403 and does no work', async (_label, build) => {
      const { body, req, signature } = build()
      const res = makeRes()

      await controller.receive(body, res, req, signature)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.status).not.toHaveBeenCalledWith(200)
      expect(mockPrisma.company.findFirst).not.toHaveBeenCalled()
      expect(mockWhatsApp.handleMessage).not.toHaveBeenCalled()
    })

    it('fails closed when META_APP_SECRET is unset', async () => {
      delete process.env.META_APP_SECRET
      const body = makeWebhookBody('any_id')
      const { req, signature } = signed(body)
      const res = makeRes()

      await controller.receive(body, res, req, signature)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(mockWhatsApp.handleMessage).not.toHaveBeenCalled()
    })

    it('accepts a correctly signed request', async () => {
      mockPrisma.company.findFirst.mockResolvedValue(null)
      const body = makeWebhookBody('any_id')
      const { req, signature } = signed(body)
      const res = makeRes()

      await controller.receive(body, res, req, signature)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.status).not.toHaveBeenCalledWith(403)
    })
  })

  // Default rollout posture on a live system: verify and log, never block.
  describe('WARN mode (META_SIGNATURE_ENFORCE unset — the shipped default)', () => {
    beforeEach(() => { delete process.env.META_SIGNATURE_ENFORCE })

    it.each(rejectionCases)('ACCEPTS %s (logs, does not block live traffic)', async (_label, build) => {
      mockPrisma.company.findFirst.mockResolvedValue(null)
      const { body, req, signature } = build()
      const res = makeRes()

      await controller.receive(body, res, req, signature)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.status).not.toHaveBeenCalledWith(403)
      // Warn mode must still record the failure for the [SIG_SUMMARY] line
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SIG] FAIL'))
    })

    it('accepts and logs when META_APP_SECRET is unset, never rejecting', async () => {
      delete process.env.META_APP_SECRET
      mockPrisma.company.findFirst.mockResolvedValue(null)
      const body = makeWebhookBody('any_id')
      const { req, signature } = signed(body)
      const res = makeRes()

      await controller.receive(body, res, req, signature)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.status).not.toHaveBeenCalledWith(403)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[SIG] UNCONFIGURED'))
    })
  })
})
