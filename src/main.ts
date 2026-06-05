import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.enableCors()
  const port = process.env.PORT ?? 3001

  // Debug: log all relevant env vars on startup
  console.log('=== ENV CHECK ===')
  console.log('NODE_ENV:', process.env.NODE_ENV)
  console.log('PORT:', process.env.PORT)
  console.log('DEFAULT_COMPANY_ID:', process.env.DEFAULT_COMPANY_ID ?? '❌ NOT SET')
  console.log('DATABASE_URL set:', !!process.env.DATABASE_URL)
  console.log('AI_API_KEY set:', !!process.env.AI_API_KEY)
  console.log('=================')

  await app.listen(port)
  console.log(`🚀 TUTIX AI CRM running on port ${port}`)
  console.log(`🧪 Test: http://localhost:${port}/webhook/test`)
}
bootstrap()
