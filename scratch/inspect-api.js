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
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value.trim();
  }
});

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  try {
    const res = await axios.get(url + '/rest/v1/', {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    });
    console.log('Exposed tables and definitions:');
    if (res.data && res.data.definitions) {
      console.log(Object.keys(res.data.definitions));
    } else {
      console.log('No definitions found in OpenAPI doc:', res.data);
    }
  } catch (error) {
    console.error('Error fetching API spec:', error.message);
  }
}

main();
