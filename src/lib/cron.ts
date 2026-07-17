import cron from 'node-cron';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

export async function startCron() {
  // Avoid running during build phase
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    console.log('[Cron] Skipping initialization during production build phase.');
    return;
  }

  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.warn('[Cron] Missing env vars — datesheet monitor will not start.');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const stateFilePath = path.join(process.cwd(), 'scratch', 'datesheet_state.json');

  // Ensure scratch dir exists
  const scratchDir = path.dirname(stateFilePath);
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  function loadState() {
    if (fs.existsSync(stateFilePath)) {
      try { return JSON.parse(fs.readFileSync(stateFilePath, 'utf8')); } catch {}
    }
    return { status: 'not_launched', lastChecked: null, totalNotified: 0 };
  }

  function saveState(state: any) {
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async function sendWhatsApp(to: string, text: string) {
    const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
    await axios.post(url, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async function logEvent(level: string, message: string) {
    console.log(`[Cron][${level.toUpperCase()}] ${message}`);
    try {
      await supabase.from('logs').insert([{ level, message }]);
    } catch {}
  }

  async function checkDatesheet() {
    const state = loadState();
    state.lastChecked = new Date().toISOString();

    try {
      const res = await axios.get('https://datesheet.vu.edu.pk/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VU-Monitor-Bot/1.0)' },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 15000,
      });

      const isLaunched = !res.data.includes('Date Sheet is not yet Launched');
      await logEvent('info', `Datesheet check: ${isLaunched ? '🚀 LAUNCHED' : 'Not yet launched'}`);

      if (isLaunched && state.status === 'not_launched') {
        state.status = 'launched';
        await logEvent('warn', '🚨 Datesheet LAUNCHED! Starting broadcast...');

        // Fetch all unique student numbers
        const { data: msgs } = await supabase
          .from('messages')
          .select('sender')
          .eq('direction', 'incoming');

        const numbers = Array.from(new Set((msgs || []).map((m: any) => m.sender).filter(Boolean))) as string[];
        await logEvent('info', `Broadcasting to ${numbers.length} student(s)...`);

        let sent = 0;
        for (const num of numbers) {
          try {
            await sendWhatsApp(num,
              '🎉 Good news! VU Datesheet has been officially launched!\nLog in to create yours: https://datesheet.vu.edu.pk/'
            );
            await supabase.from('messages').insert([{
              sender: num,
              text: '🎉 Good news! VU Datesheet has been officially launched! Log in to create yours: https://datesheet.vu.edu.pk/',
              direction: 'outgoing',
            }]);
            sent++;
            await new Promise(r => setTimeout(r, 250)); // rate-limit delay
          } catch (e: any) {
            await logEvent('error', `Failed to notify ${num}: ${e.message}`);
          }
        }

        state.totalNotified = sent;
        await logEvent('info', `Broadcast done. Notified ${sent}/${numbers.length} students.`);

      } else if (!isLaunched && state.status === 'launched') {
        // Portal reverted
        state.status = 'not_launched';
        await logEvent('info', 'Datesheet portal reverted to: Not Yet Launched.');
      }

    } catch (err: any) {
      await logEvent('error', `Datesheet fetch failed: ${err.message}`);
    }

    saveState(state);
  }

  // Run check immediately on startup
  await checkDatesheet();

  // Schedule: every 10 minutes
  cron.schedule('*/10 * * * *', () => {
    checkDatesheet();
  });

  console.log('[Cron] ✅ Datesheet monitor started (every 10 minutes).');
}
