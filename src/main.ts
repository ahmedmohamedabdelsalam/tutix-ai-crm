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
}

bootstrap()
