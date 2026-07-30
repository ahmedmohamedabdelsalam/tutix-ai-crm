import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableCors()
  const port = process.env.PORT || 3001
  await app.listen(port, '0.0.0.0')
  console.log(`🚀 TUTIX AI CRM running on port ${port}`)
  console.log(`PORT env value: ${process.env.PORT}`)
  console.log(`DEFAULT_COMPANY_ID: ${process.env.DEFAULT_COMPANY_ID}`)
  console.log(`DATABASE_URL set: ${!!process.env.DATABASE_URL}`)
  const rawFlag = process.env.USE_DB_CATALOG ?? ''
  const resolvedFlag = ['true', '1', 'yes'].includes(rawFlag.replace(/^["']|["']$/g, '').trim().toLowerCase())
  console.log(`[STARTUP] USE_DB_CATALOG raw="${rawFlag}" → resolved=${resolvedFlag}`)
}

bootstrap()
