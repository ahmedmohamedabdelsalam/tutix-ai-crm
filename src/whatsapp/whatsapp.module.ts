import { Module } from '@nestjs/common'
import { WhatsAppController } from './whatsapp.controller'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'

@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppService, FollowUpService],
})
export class WhatsAppModule {}
