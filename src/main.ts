// Catch anything that crashes the process before NestJS starts
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message)
  console.error(err.stack)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason)
  process.exit(1)
})

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  console.log('▶ bootstrap() starting...')
  console.log('Node version:', process.version)
  console.log('PORT env:', process.env.PORT)
  console.log('DATABASE_URL set:', !!process.env.DATABASE_URL)

  const app = await NestFactory.create(AppModule)
  app.enableCors()

  const port = parseInt(process.env.PORT ?? '3001', 10)
  await app.listen(port, '0.0.0.0')
  console.log(`🚀 TUTIX AI CRM running on port ${port}`)
}

bootstrap().catch((err) => {
  console.error('💥 bootstrap() failed:', err.message)
  console.error(err.stack)
  process.exit(1)
})
