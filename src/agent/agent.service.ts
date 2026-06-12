import Anthropic from '@anthropic-ai/sdk';
import { Industry } from '@prisma/client';
import { buildBasePersonality } from './prompts/base-personality';
import { getIndustryPrompt } from './prompts/index';
import { findHotelInMessage } from './prompts/hajj-umrah-hotels';

// Lazy init — created on first use, after NestJS has loaded env vars
let _anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _anthropic;
}

function buildSystemPrompt(
  companyName: string,
  packages: string,
  aiPrompt: string,
  waPhone: string,
  industry: Industry = Industry.HAJJ_UMRAH,
  returningCustomer?: { name: string; tripsCount: number },
): string {
  const bookingCta = waPhone
    ? `قل: "تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله وللتواصل المباشر: ${waPhone}"`
    : `قل: "تمام يافندم هحول حضرتك لزميلي المختص يكمل معاك خطوات الحجز إن شاء الله"`;

  const { identity, catalog, hotels } = getIndustryPrompt(industry, companyName);
  let prompt = buildBasePersonality(identity, catalog, bookingCta, hotels, returningCustomer);

  // Append DB-driven updates (override base prices if contradicted)
  if (packages && packages.trim()) {
    prompt += `\n\n═══════════════════════════════
التحديثات الأخيرة على الأسعار والبرامج
═══════════════════════════════
(هذه التحديثات تُلغي الأسعار الأساسية عند التعارض)
${packages.trim()}`;
  }

  // Append operational notes / special instructions
  if (aiPrompt && aiPrompt.trim()) {
    prompt += `\n\n═══════════════════════════════
تعليمات وملاحظات إضافية
═══════════════════════════════
${aiPrompt.trim()}`;
  }

  // Anti-hallucination rule always last — closest to generation
  prompt += `\n\nتوقف بعد ردّك مباشرة — لا تكتب ما يمكن أن يقوله العميل بعدها`;

  return prompt;
}

function cleanAgentResponse(text: string): string {
  // Strip any lines that are purely "للعمرة" (model preamble) and remove leading blank lines
  let t = text
    .split('\n')
    .filter(line => !/^للعمرة[\s\W]*$/.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '');

  // Strip single-word leading fragment — model sometimes completes user's last word first
  // e.g. user says "10" → model outputs "ايام\nتمام يا أستاذ..." ; "المدينه" → "اولا\nتمام..."
  const firstNlIdx = t.indexOf('\n');
  if (firstNlIdx > 0) {
    const firstToken = t.substring(0, firstNlIdx).trim();
    // Single word (no spaces), ≤10 chars, no question mark or ━ = likely a preamble fragment
    if (!firstToken.includes(' ') && firstToken.length <= 10 && !firstToken.includes('؟') && !firstToken.includes('━')) {
      const rest = t.substring(firstNlIdx).replace(/^\n+/, '');
      if (rest.length > 15) t = rest;
    }
  }

  // Strip conversation-delimiter artifacts like <<HUMAN_CONVERSATION_END>> — truncate at first "<<"
  const delimIdx = t.indexOf('<<');
  if (delimIdx !== -1) t = t.substring(0, delimIdx).trimEnd();

  // Truncate hallucinated customer turns — model sometimes generates fake customer replies.
  // Two strategies:
  // 1. Known markers for first-person customer phrases
  const fakeCustomerMarkers = [
    '\n\nتمام — أنا ', '\n\nأنا عايز', '\n\nأنا هاخد', '\n\nأيوه،',
    '\n\nتمام كويس', '\n\nتمام حلو', '\n\nاحنا نفكر', '\n\nهنفكر',
    '\n\nهنكلمك', '\n\nنرد عليك', '\n\nسنفكر', '\n\nعايز احجز',
    '\n\nعايزة احجز', '\n\nموافق نحجز', '\n\nهحجز', '\n\nعايز ',
    '\n\nعايزة ',
  ];
  for (const marker of fakeCustomerMarkers) {
    const idx = t.indexOf(marker);
    if (idx !== -1) t = t.substring(0, idx).trimEnd();
  }
  // 2. Structural detection: if a short middle paragraph contains a customer-style hallucination.
  // "احنا" removed — agent also uses it to mean "we (the company)"
  const customerWords = ['أنا عايز', 'أنا هاخد', 'هنفكر', 'نرد عليك', 'هنكلمك', 'سنفكر', 'نفكر فيها'];
  const blocks = t.split('\n\n');
  if (blocks.length >= 3) {
    for (let i = 1; i < blocks.length - 1; i++) {
      const block = blocks[i].trim();
      const isKnownPhrase = customerWords.some(kw => block.includes(kw));
      // Very short isolated block (≤8 chars) with no ⭐ = one-word fake customer reply (e.g. "يوليو", "10 ايام")
      const isOneWordReply = block.length <= 8 && !block.includes('⭐') && !block.includes('—');
      if (block.length <= 80 && !block.includes('⭐') && (isKnownPhrase || isOneWordReply)) {
        t = blocks.slice(0, i).join('\n\n').trimEnd();
        break;
      }
    }
  }

  const cleaned = t
    .replace(/\*\*/g, '')          // remove markdown bold **
    .replace(/[،!]/g, '')          // remove ، !
    .replace(/(?<!\S)\.|\.(?!\S)/g, '') // remove standalone dots (not inside URLs/words)
    .replace(/—/g, ' ')            // remove em-dashes (replaced with space)
    .replace(/[ \t]+/g, ' ')  // normalize spaces (preserve newlines for package cards)
    .trim();
  return cleaned || text.trim(); // fallback to original if cleaning empties the string
}

export async function getAgentReply(
  history: { role: string; content: string }[],
  companyName: string,
  packages: string,
  aiPrompt = '',
  waPhone = '',
  industry: Industry = Industry.HAJJ_UMRAH,
  returningCustomer?: { name: string; tripsCount: number },
): Promise<string> {
  try {
    const messages = history.map((m) => ({
      role: m.role.toLowerCase() === 'user' ? 'user' as const : 'assistant' as const,
      content: m.content,
    }));

    // Detect hotel name in last user message → injected as a separate uncached block
    const lastUserMsg = history.filter(m => m.role.toLowerCase() === 'user').slice(-1)[0]?.content ?? '';
    const hotelOverride = findHotelInMessage(lastUserMsg);

    // Base system prompt is identical across all calls for the same company → cache it.
    // Hotel override (when present) is appended as a second uncached block so the
    // cached portion stays stable and gets a cache hit on every subsequent message.
    const sysPrompt = buildSystemPrompt(companyName, packages, aiPrompt, waPhone, industry, returningCustomer);
    const systemBlocks = [
      { type: 'text' as const, text: sysPrompt, cache_control: { type: 'ephemeral' as const } },
      ...(hotelOverride ? [{ type: 'text' as const, text: hotelOverride }] : []),
    ];

    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      temperature: 0.3,
      system: systemBlocks,
      messages,
    });

    const u = response.usage;
    console.log(`CACHE: write=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0} input=${u.input_tokens} output=${u.output_tokens}`);

    const rawReply =
      response.content[0]?.type === 'text'
        ? response.content[0].text
        : 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين';
    console.log(`RAW_REPLY: ${rawReply.substring(0, 300).replace(/\n/g, '↵')}`);
    return cleanAgentResponse(rawReply);
  } catch (err) {
    console.error('AI error:', err);
    return 'عذراً حدث خطأ سيتواصل معك أحد المتخصصين قريباً';
  }
}

export async function extractLeadData(
  history: { role: string; content: string }[],
): Promise<Partial<LeadData>> {
  const prompt = `من المحادثة التالية استخرج بيانات العميل. أجب بـ JSON فقط:
{"name":"الاسم أو null","packageType":"حج أو عمرة أو null","groupSize":عدد أو null,"budget":"الميزانية أو null","travelDate":"الموعد أو null","isReadyToBook":true أو false}

قاعدة مهمة: isReadyToBook يكون true فقط إذا قال العميل صراحةً إنه يريد الحجز الآن بعبارات مثل "عايز احجز" أو "هحجز" أو "موافق نحجز". مجرد السؤال عن العمرة أو الأسعار لا يعني الاستعداد للحجز.

المحادثة:
${history.map((m) => `${m.role === 'user' ? 'العميل' : 'المساعد'}: ${m.content}`).join('\n')}`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : '{}';
    const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
    return JSON.parse(json) as Partial<LeadData>;
  } catch {
    return {};
  }
}

export function calculateScore(data: Partial<LeadData>): number {
  let score = 0;
  if (data.name) score += 20;
  if (data.groupSize) score += 15;
  if (data.budget) score += 25;
  if (data.travelDate) score += 25;
  if (data.packageType) score += 15;
  return score;
}

const BOOKING_KEYWORDS = [
  'عايز احجز', 'عايزة احجز', 'هحجز', 'موافق نحجز', 'تمام هنحجز',
  'خد الحجز', 'احجزلي', 'احجزي لي', 'نحجز دلوقتي', 'كمل الحجز',
  'ابدأ الحجز', 'خليني احجز', 'اوك نحجز', 'اوكيه نحجز',
];

function hasExplicitBookingIntent(lastUserMessage: string): boolean {
  const normalized = lastUserMessage.trim().toLowerCase();
  return BOOKING_KEYWORDS.some(kw => normalized.includes(kw));
}

export function shouldHandoff(
  score: number,
  msgCount: number,
  data: Partial<LeadData>,
  lastUserMessage = '',
): { yes: boolean; reason: string } {
  // Handoff only on explicit booking keyword in the actual message (never on score alone)
  if (hasExplicitBookingIntent(lastUserMessage)) {
    return { yes: true, reason: 'العميل جاهز للحجز' };
  }
  // Safety fallback for very long conversations (30 total msgs = ~15 exchanges)
  if (msgCount >= 30) return { yes: true, reason: 'محادثة طويلة' };
  return { yes: false, reason: '' };
}

export interface LeadData {
  name: string;
  phone: string;
  packageType: string;
  groupSize: number;
  budget: string;
  travelDate: string;
  isReadyToBook: boolean;
}
