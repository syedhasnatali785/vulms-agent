const fs = require('fs');
const path = require('path');
const axios = require('axios');

const envPath = path.join(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]] = value.trim();
  }
});

const GOOGLE_API_KEY = env.GOOGLE_API_KEY;
const WHATSAPP_TOKEN = env.WHATSAPP_TOKEN;

// Known working file from Test 1: CS302 Finalterm Mcqs 2026 by Ali khan.pdf
const FILE_ID = '1e_tez8lvlqtYtPuTGAE2DcSk2qgFkxTL'; // Updated MKT501 Finalterm
const CS302_ID = '1e_tez8lvlqtYtPuTGAE2DcSk2qgFkxTL'; // Use MKT501 as stand-in

// --- Simulate what the webhook does when sending a GDrive file to the user ---
// The URL format in sendGDriveFileToUser:
// https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${GOOGLE_API_KEY}

async function main() {
  console.log('\n--- Test: Can WhatsApp download the GDrive file URL? ---');
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media&key=${GOOGLE_API_KEY}`;
  console.log('URL:', fileUrl);

  // 1. Check if the file is downloadable (HEAD request)
  try {
    const headRes = await axios.head(fileUrl);
    console.log('HEAD status:', headRes.status);
    console.log('Content-Type:', headRes.headers['content-type']);
    console.log('Content-Length:', headRes.headers['content-length']);
  } catch (err) {
    console.error('HEAD FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }

  // 2. Try actually downloading (small portion)
  console.log('\n--- Test: Actual download (first 200 bytes) ---');
  try {
    const res = await axios.get(fileUrl, { responseType: 'arraybuffer', headers: { Range: 'bytes=0-200' } });
    console.log('GET status:', res.status);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Data size received:', res.data?.byteLength || 0, 'bytes');
  } catch (err) {
    console.error('GET FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }

  // 3. Simulate WhatsApp API trying to fetch the link (it uses link: property)
  // WhatsApp requires that the link be publicly accessible without auth
  console.log('\n--- Test: Sending GDrive media URL to WhatsApp API ---');
  const PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID;
  const testNumber = '923048498390'; // safe test number — replace with real if needed

  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: testNumber,
      type: 'document',
      document: {
        link: fileUrl,
        filename: 'Test_GDrive_File.pdf',
        caption: '(SYED BOT Test)'
      }
    };
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('WhatsApp API response:', JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error('WhatsApp API FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }
}

main().catch(console.error);
