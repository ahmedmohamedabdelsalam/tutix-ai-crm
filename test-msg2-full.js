require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load the full system prompt from compiled code
const { getAgentReply } = require('./dist/src/agent/agent.service');

async function test() {
  console.log('Testing msg2 with full getAgentReply...\n');

  const history = [
    { role: 'user', content: 'السلام عليكم' },
    { role: 'assistant', content: 'ورحمة الله وبركاته\n\nتشرفنا باسم حضرتك؟' },
    { role: 'user', content: 'أحمد' },
  ];

  const reply = await getAgentReply(history, 'إسكندرية الدولية للسياحة', '', '', '');
  console.log('Reply:', reply);
}

test().catch(e => console.error('Error:', e.message));
