import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule)
    app.enableCors()

    const port = parseInt(process.env.PORT ?? '3001', 10)

    console.log('=== STARTUP ===')
    console.log('PORT:', port)
    console.log('NODE_ENV:', process.env.NODE_ENV)
    console.log('DEFAULT_COMPANY_ID:', process.env.DEFAULT_COMPANY_ID ?? 'NOT SET')
    console.log('DATABASE_URL set:', !!process.env.DATABASE_URL)
    console.log('AI_API_KEY set:', !!process.env.AI_API_KEY)
    console.log('===============')

    await app.listen(port, '0.0.0.0')
    console.log(`🚀 TUTIX AI CRM running on port ${port}`)
  } catch (err) {
    console.error('❌ FATAL STARTUP ERROR:', err)
    process.exit(1)
  }
}
bootstrap()
