const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Manually parse .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim();
      envVars[key] = val;
    }
  }
});

const supabaseUrl = envVars.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = envVars.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing env vars!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function run() {
  console.log("=== RECENT LOGS ===");
  const { data: logs, error: err1 } = await supabase
    .from('logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(30);

  if (err1) {
    console.error("Error reading logs:", err1);
  } else {
    logs.reverse().forEach(l => {
      console.log(`[${l.created_at}] [${l.level.toUpperCase()}] ${l.message}`);
    });
  }

  console.log("\n=== RECENT MESSAGES ===");
  const { data: messages, error: err2 } = await supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (err2) {
    console.error("Error reading messages:", err2);
  } else {
    messages.reverse().forEach(m => {
      console.log(`[${m.created_at}] [${m.direction.toUpperCase()}] ${m.sender}: ${m.text}`);
    });
  }
}

run();
