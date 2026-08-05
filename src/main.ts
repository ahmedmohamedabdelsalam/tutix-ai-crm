import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { isSignatureEnforced } from './whatsapp/internal-auth'

async function bootstrap() {
  // rawBody: required to verify Meta's X-Hub-Signature-256 HMAC over the exact
  // bytes received — a re-serialized body would not match the signature.
  const app = await NestFactory.create(AppModule, { rawBody: true })
  app.enableCors()
  const port = process.env.PORT || 3001
  await app.listen(port, '0.0.0.0')
  console.log(`🚀 TUTIX AI CRM running on port ${port}`)
  console.log(`PORT env value: ${process.env.PORT}`)
  console.log(`DEFAULT_COMPANY_ID: ${process.env.DEFAULT_COMPANY_ID}`)
  console.log(`DATABASE_URL set: ${!!process.env.DATABASE_URL}`)
  const enforce = isSignatureEnforced()
  console.log(
    `[STARTUP] META_SIGNATURE_ENFORCE raw="${process.env.META_SIGNATURE_ENFORCE ?? ''}" → ${enforce ? 'ENFORCE (invalid signatures rejected)' : 'WARN (verified + logged, all requests accepted)'}` +
    ` | META_APP_SECRET ${process.env.META_APP_SECRET ? 'set' : 'NOT SET'}`,
  )
  const rawFlag = process.env.USE_DB_CATALOG ?? ''
  const resolvedFlag = ['true', '1', 'yes'].includes(rawFlag.replace(/^["']|["']$/g, '').trim().toLowerCase())
  console.log(`[STARTUP] USE_DB_CATALOG raw="${rawFlag}" → resolved=${resolvedFlag}`)
}

bootstrap()
