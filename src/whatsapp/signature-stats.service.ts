import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { formatSignatureSummary } from './internal-auth'

/**
 * Emits one [SIG_SUMMARY] line per hour so the owner can read the signature
 * rollout status straight from Railway logs — how many inbound webhook requests
 * passed vs failed verification, and whether it is safe to flip
 * META_SIGNATURE_ENFORCE to true.
 *
 * Hourly rather than daily so the first hours of a rollout are observable; one
 * line per hour is negligible log volume. Counts are in-memory and reset on every
 * deploy or restart — the `since` timestamp in the line makes that explicit.
 */
@Injectable()
export class SignatureStatsService {
  @Cron('0 * * * *')
  logHourlySummary(): void {
    console.log(formatSignatureSummary())
  }
}
