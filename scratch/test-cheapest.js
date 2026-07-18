const axios = require('axios');
const fs = require('fs');

// Read .env.local manually
let CLOUDFLARE_ACCOUNT_ID = '';
let CLOUDFLARE_API_TOKEN = '';

try {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    const parts = line.trim().split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      if (key === 'CLOUDFLARE_ACCOUNT_ID') CLOUDFLARE_ACCOUNT_ID = val;
      if (key === 'CLOUDFLARE_API_TOKEN') CLOUDFLARE_API_TOKEN = val;
    }
  }
} catch (e) {
  console.error('Could not read .env.local', e);
}

async function testModel(modelName) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${modelName}`;
  console.log(`Testing model: ${modelName}`);
  try {
    const response = await axios.post(
      url,
      { messages: [{ role: 'user', content: 'Respond with exactly: {"type":"chat","reply":"TEST"}' }] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`Success! Response for ${modelName}:`);
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(`Failed for ${modelName}: status=${error.response?.status}, message=${error.response?.data?.errors?.[0]?.message || error.message}`);
  }
}

async function main() {
  await testModel('@cf/meta/llama-3.2-1b-instruct');
  await testModel('@cf/meta/llama-3.2-3b-instruct');
}

main();
