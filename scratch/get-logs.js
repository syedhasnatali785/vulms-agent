const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Read .env.local manually
let supabaseUrl = '';
let supabaseServiceKey = '';

try {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    const parts = line.trim().split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      if (key === 'NEXT_PUBLIC_SUPABASE_URL') supabaseUrl = val;
      if (key === 'SUPABASE_SERVICE_ROLE_KEY') supabaseServiceKey = val;
    }
  }
} catch (e) {
  console.error('Could not read .env.local', e);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  console.log('Fetching logs...');
  const { data: logs, error: logsError } = await supabase
    .from('logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (logsError) {
    console.error('Error fetching logs:', logsError);
  } else {
    console.log('LOGS:');
    logs.forEach(l => {
      console.log(`[${l.created_at || l.timestamp}] [${l.level}] ${l.message}`);
    });
  }

  console.log('\nFetching recent messages...');
  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (messagesError) {
    console.error('Error fetching messages:', messagesError);
  } else {
    console.log('MESSAGES:');
    messages.forEach(m => {
      console.log(`[${m.created_at}] [${m.direction}] SENDER: ${m.sender} - ${m.text}`);
    });
  }
}

main();
