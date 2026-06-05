# TUTIX AI CRM
First product by TUTIX company.
Multi-tenant SaaS CRM with WhatsApp AI Agent for Hajj & Umrah companies in Egypt.

## Stack
- NestJS + TypeScript
- PostgreSQL + Prisma
- Groq AI (testing) / OpenAI (production)
- Meta WhatsApp Cloud API

## Rules - Never Break
1. Every DB query MUST have companyId filter
2. AI model always from ENV never hardcoded
3. Always return 200 to Meta webhook immediately
4. All user messages in Arabic

## Lead Score
name=20, groupSize=15, budget=25, travelDate=25, packageType=15
score >= 70 = HOT = handoff to Sales
