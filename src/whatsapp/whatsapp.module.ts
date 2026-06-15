import { Module } from '@nestjs/common'
import { WhatsAppController } from './whatsapp.controller'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'
import { TokenMonitorService } from './token-monitor.service'

@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppService, FollowUpService, TokenMonitorService],
  exports: [TokenMonitorService],
})
export class WhatsAppModule {}
