const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Parse .env.local manually
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
console.log('API Key present:', !!GOOGLE_API_KEY, '| Key prefix:', GOOGLE_API_KEY?.substring(0, 10));

// A sample root folder ID from gdrive.ts
const TEST_FOLDER = '1zJW41VjmF7YZJU8OfE2TWMk3jXQ0okcD';
const QUERY = 'cs302';

async function main() {
  // --- Test 1: List files in the root folder (no query filter) ---
  console.log('\n--- Test 1: Listing files in root folder (no name filter) ---');
  try {
    const q1 = `'${TEST_FOLDER}' in parents and trashed = false`;
    const r1 = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: { q: q1, key: GOOGLE_API_KEY, fields: 'files(id, name, mimeType)', pageSize: 10 }
    });
    const files1 = r1.data?.files || [];
    console.log(`Found ${files1.length} files/folders:`);
    files1.forEach(f => console.log(` - [${f.mimeType}] ${f.name} (${f.id})`));
  } catch (err) {
    console.error('Test 1 FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }

  // --- Test 2: Search with a course code ---
  console.log(`\n--- Test 2: Search for "${QUERY}" in root folder ---`);
  try {
    const q2 = `'${TEST_FOLDER}' in parents and name contains '${QUERY}' and trashed = false`;
    const r2 = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: { q: q2, key: GOOGLE_API_KEY, fields: 'files(id, name, mimeType)', pageSize: 10 }
    });
    const files2 = r2.data?.files || [];
    console.log(`Found ${files2.length} files matching "${QUERY}":`);
    files2.forEach(f => console.log(` - ${f.name}`));
  } catch (err) {
    console.error('Test 2 FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }

  // --- Test 3: Discover sub-folders (BFS step 1) ---
  console.log('\n--- Test 3: Listing sub-folders of root folder ---');
  try {
    const q3 = `'${TEST_FOLDER}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const r3 = await axios.get('https://www.googleapis.com/drive/v3/files', {
      params: { q: q3, key: GOOGLE_API_KEY, fields: 'files(id, name, mimeType)', pageSize: 20 }
    });
    const folders = r3.data?.files || [];
    console.log(`Found ${folders.length} sub-folders:`);
    folders.forEach(f => console.log(` - ${f.name} (${f.id})`));

    if (folders.length > 0) {
      // --- Test 4: Search in a discovered sub-folder ---
      const subFolder = folders[0];
      console.log(`\n--- Test 4: Search for "${QUERY}" in sub-folder "${subFolder.name}" ---`);
      const q4 = `'${subFolder.id}' in parents and name contains '${QUERY}' and trashed = false`;
      const r4 = await axios.get('https://www.googleapis.com/drive/v3/files', {
        params: { q: q4, key: GOOGLE_API_KEY, fields: 'files(id, name, mimeType)', pageSize: 10 }
      });
      const files4 = r4.data?.files || [];
      console.log(`Found ${files4.length} files matching "${QUERY}" in "${subFolder.name}":`);
      files4.forEach(f => console.log(` - ${f.name}`));
    }
  } catch (err) {
    console.error('Test 3 FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }

  // --- Test 5: Validate a direct file download URL ---
  console.log('\n--- Test 5: Get info about the root folder itself ---');
  try {
    const r5 = await axios.get(`https://www.googleapis.com/drive/v3/files/${TEST_FOLDER}`, {
      params: { key: GOOGLE_API_KEY, fields: 'id,name,mimeType,capabilities' }
    });
    console.log('Folder info:', JSON.stringify(r5.data, null, 2));
  } catch (err) {
    console.error('Test 5 FAILED:', err.response?.status, JSON.stringify(err.response?.data || err.message));
  }
}

main().catch(console.error);
