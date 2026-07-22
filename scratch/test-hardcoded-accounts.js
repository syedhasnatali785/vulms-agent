const axios = require('axios');

const CLOUDFLARE_ACCOUNTS = [
  // Second Cloudflare Account
  {
    id: 'cc35137ba735c5cfce2c15703dd9d4e5',
    token: 'cfut_P9jGaLwA6OR8GziNRulqVq4aAKPhsZPJjn9xC2Nrd7098765',
  },
  // Third Cloudflare Account
  {
    id: '89c82d8514139b83207a28d960146ebb',
    token: 'cfut_8cfaTHPHNUdev2tOFViiiTf5OgZRfxLLqoBP26F524ef62b1',
  }
];

const AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

async function testAccounts() {
  for (let i = 0; i < CLOUDFLARE_ACCOUNTS.length; i++) {
    const acc = CLOUDFLARE_ACCOUNTS[i];
    const url = `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/${AI_MODEL}`;
    console.log(`Testing Account ${i + 2} (ID: ${acc.id})...`);

    try {
      const response = await axios.post(
        url,
        {
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hi, respond with the single word: "SUCCESS".' }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${acc.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      console.log(`Account ${i + 2} Success! Response:`, JSON.stringify(response.data));
    } catch (error) {
      console.error(`Account ${i + 2} Failed:`, error.response?.data || error.message);
    }
  }
}

testAccounts();
