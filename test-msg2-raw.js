require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Build the full system prompt inline (copy from compiled JS)
// Instead, let's patch into agent.service by requiring its internal buildSystemPrompt
// We'll use a trick: eval the compiled JS to get the buildSystemPrompt function

const fs = require('fs');
const agentCode = fs.readFileSync('./dist/src/agent/agent.service.js', 'utf8');

// Extract just the system prompt by calling the API and logging it
async function test() {
  // Manually rebuild the prompt to verify it
  const Anthropic2 = require('@anthropic-ai/sdk');

  // Just call with intercepted logs
  const origCreate = client.messages.create.bind(client.messages);

  let capturedSystem = '';
  client.messages.create = async function(params) {
    capturedSystem = params.system || '';
    console.log('\n=== SYSTEM PROMPT LENGTH:', capturedSystem.length, 'chars ===');
    console.log('First 300 chars:', capturedSystem.substring(0, 300));
    console.log('...');
    const result = await origCreate(params);
    console.log('\nstop_reason:', result.stop_reason);
    console.log('content length:', result.content.length);
    if (result.content[0]) {
      console.log('content[0].type:', result.content[0].type);
      console.log('content[0].text (first 200):', (result.content[0].text || '').substring(0, 200));
    } else {
      console.log('content[0]: UNDEFINED/EMPTY ARRAY');
    }
    return result;
  };

  const { getAgentReply } = require('./dist/src/agent/agent.service');

  const history = [
    { role: 'user', content: 'السلام عليكم' },
    { role: 'assistant', content: 'ورحمة الله وبركاته\n\nتشرفنا باسم حضرتك؟' },
    { role: 'user', content: 'أحمد' },
  ];

  const reply = await getAgentReply(history, 'إسكندرية الدولية للسياحة', '', '', '');
  console.log('\nFinal reply:', reply);
}

test().catch(e => console.error('Error:', e.message));
