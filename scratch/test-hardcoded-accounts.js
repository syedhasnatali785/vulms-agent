const axios = require('axios');

const CLOUDFLARE_ACCOUNTS = [
  // Second Cloudflare Account
  {
    id: Buffer.from('Y2MzNTEzN2JhNzM1YzVjZmNlMmMxNTcwM2RkOWQ0ZTU=', 'base64').toString('utf-8'),
    token: Buffer.from('Y2Z1dF9QOWpHYUx3QTZPUjhHemlOUnVscVZxNGFBS1Boc1pQSmpuOXhDMk5yZDcwOTg3NjU=', 'base64').toString('utf-8'),
  },
  // Third Cloudflare Account
  {
    id: Buffer.from('ODljODJkODUxNDEzOWI4MzIwN2EyOGQ5NjAxNDZlYmI=', 'base64').toString('utf-8'),
    token: Buffer.from('Y2Z1dF84Y2ZhVEhQSE5VZGV2MnRPRlZpaWlUZjVPZ1pSZnhMTHFvQlAyNkY1MjRlZjYyYjE=', 'base64').toString('utf-8'),
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
