const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env.local
loadEnvConfig(process.cwd());

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ Missing required environment configuration variables in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const stateFilePath = path.join(process.cwd(), 'scratch', 'datesheet_state.json');

// Ensure scratch directory exists
const scratchDir = path.dirname(stateFilePath);
if (!fs.existsSync(scratchDir)) {
  fs.mkdirSync(scratchDir, { recursive: true });
}

// Helper: load state
function loadState() {
  if (fs.existsSync(stateFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    } catch (e) {
      // Ignore parse error
    }
  }
  return {
    status: 'not_launched',
    lastChecked: null,
    totalNotified: 0,
    history: []
  };
}

// Helper: save state
function saveState(state) {
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

// Helper: send WhatsApp message
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return res.data;
  } catch (e) {
    console.error(`[WhatsApp API Error] Failed to notify ${to}:`, e.response?.data || e.message);
    throw e;
  }
}

// Helper: save outgoing message to Supabase
async function logMessageToDb(sender, text) {
  try {
    await supabase
      .from('messages')
      .insert([{ sender, text, direction: 'outgoing' }]);
  } catch (err) {
    // Ignore db logging errors
  }
}

// Helper: save log event to Supabase
async function logEventToDb(level, message) {
  try {
    await supabase
      .from('logs')
      .insert([{ level, message }]);
  } catch (err) {
    console.log(`[Event Log Fallback] [${level.toUpperCase()}] ${message}`);
  }
}

// Check datesheet webpage
async function checkDatesheet() {
  console.log(`[Monitor] Checking datesheet status at ${new Date().toISOString()}...`);
  const state = loadState();
  state.lastChecked = new Date().toISOString();

  try {
    const res = await axios.get('https://datesheet.vu.edu.pk/', {
      headers: {
        'User-Agent': 'Mozilla/5.5 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      }),
      timeout: 15000
    });

    const html = res.data;
    const isLaunched = !html.includes('Date Sheet is not yet Launched');

    if (isLaunched) {
      console.log("[Monitor] 🚨 ALERT! Date Sheet has been LAUNCHED!");
      
      // If transitioning from not_launched to launched
      if (state.status === 'not_launched') {
        state.status = 'launched';
        await logEventToDb('warn', '🚨 Date Sheet launch detected on datesheet.vu.edu.pk!');

        // Fetch unique users who contacted this bot
        const { data: messages, error } = await supabase
          .from('messages')
          .select('sender')
          .eq('direction', 'incoming');

        if (error) {
          console.error('[Monitor] Error fetching unique student numbers from Supabase:', error);
          await logEventToDb('error', `Failed to fetch students list: ${error.message}`);
          saveState(state);
          return;
        }

        const studentNumbers = Array.from(new Set((messages || []).map(m => m.sender).filter(Boolean)));
        console.log(`[Monitor] Found ${studentNumbers.length} unique students to notify.`);
        await logEventToDb('info', `Sending launch notification broadcast to ${studentNumbers.length} students...`);

        let successCount = 0;
        for (const num of studentNumbers) {
          try {
            await sendWhatsAppMessage(num, "🎉 Good news! Virtual University Datesheet has been officially launched! Log in here to make yours: https://datesheet.vu.edu.pk/");
            await logMessageToDb(num, "🎉 Good news! Virtual University Datesheet has been officially launched! Log in here to make yours: https://datesheet.vu.edu.pk/");
            successCount++;
            // Small pause to avoid hitting rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (sendErr) {
            console.error(`[Monitor] Error sending broadcast to ${num}:`, sendErr.message);
          }
        }

        state.totalNotified = successCount;
        await logEventToDb('info', `Broadcast completed. Successfully notified ${successCount} of ${studentNumbers.length} students.`);
      }
    } else {
      console.log("[Monitor] Date Sheet is still NOT launched.");
      // If it was launched but is now showing not_launched (reverted)
      if (state.status === 'launched') {
        state.status = 'not_launched';
        await logEventToDb('info', 'VU Datesheet status reset back to: Not Yet Launched.');
      }
    }
  } catch (err) {
    console.error('[Monitor] Error checking datesheet portal:', err.message);
    await logEventToDb('error', `Datesheet crawler exception: ${err.message}`);
  }

  saveState(state);
}

// Start polling loop (checks every 10 minutes)
const INTERVAL_MS = 10 * 60 * 1000;
checkDatesheet();
setInterval(checkDatesheet, INTERVAL_MS);
console.log(`[Monitor] Background datesheet monitor daemon started (Interval: 10 minutes)`);
