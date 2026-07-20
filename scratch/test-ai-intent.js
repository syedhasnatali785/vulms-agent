const axios = require('axios');
const fs = require('fs');

// Read .env.local manually
let CLOUDFLARE_ACCOUNT_ID = '';
let CLOUDFLARE_API_TOKEN = '';
let AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8'; // Default fallback

try {
  const envContent = fs.readFileSync('.env.local', 'utf8');
  const lines = envContent.split('\n');
  for (const line of lines) {
    const parts = line.trim().split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts.slice(1).join('=').trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key === 'CLOUDFLARE_ACCOUNT_ID') CLOUDFLARE_ACCOUNT_ID = val;
      if (key === 'CLOUDFLARE_API_TOKEN') CLOUDFLARE_API_TOKEN = val;
      if (key === 'CLOUDFLARE_AI_MODEL') AI_MODEL = val;
    }
  }
} catch (e) {
  console.error('Could not read .env.local', e);
}
console.log(`Loaded Account ID: ${CLOUDFLARE_ACCOUNT_ID ? 'YES' : 'NO'}`);
console.log(`Loaded API Model: ${AI_MODEL}`);

async function testUserIntent(userMessage, history = [], isAdmin = false) {
  const fileNames = "cs302_handout.pdf (ID: 1), mth101_midterm.pdf (ID: 2), eng201_final_term.pdf (ID: 3)";
  const systemPrompt = `you're **SYED 1.2**, an AI Model built by **Syed Hasnat Ali**.

you evaluate student messages and decide the appropriate action. Stick to student queries regarding study and materials. Do not be irrelevant.
You can send users documents/videos/images that have been uploaded to our database or are available in our Google Drive directories.

The user's role is: ${isAdmin ? 'ADMIN' : 'STANDARD USER'}.
Available database files right now: ${fileNames}.

### OPERATIONAL WORKFLOW FOR FILE REQUESTS:
Follow these steps in sequence when a student asks for files, handouts, or past papers:
- **Step 1 (Clarification & Confirmation)**: If the conversation history (provided below) does NOT show that you have already asked for confirmation and details, you must reply using **Format 1 (Chat)**. Ask the user if they would like to search, how many files they need, and what term/exam they are preparing for (midterm or final).
- **Step 2 (Trigger Search)**: If the conversation history shows you have already asked for confirmation/details, and the user has explicitly confirmed they want to search, you must reply using **Format 2 (Trigger File Search)** to initiate the search on the server.

### ADDITIONAL RULES:
- Do NOT simulate search results or list files yourself in the chat text. The search is executed on the server via Google Drive and Database APIs.
- The "Available database files right now" list is only a subset of recently uploaded files. We have thousands of Virtual University files (handouts, notes, papers) for ALL courses in our Google Drive repository, so you can always search for any course!

### RESPONSE FORMATS (MUST OUTPUT ONLY VALID JSON):
You must output exactly one of the following JSON formats based on the intent:

Format 1: Chat or Confirmation Request (use this for general chat, greetings, and when asking questions/collecting details/confirmation)
{
  "type": "chat",
  "reply": "<your friendly response conforming to your persona, or asking the user to confirm/clarify/provide details>"
}

Format 2: Trigger File Search (use this ONLY after the user has explicitly confirmed they want to search)
{
  "type": "send_file",
  "search_query": "<the specific course code or filename query to search, e.g. 'cs302', 'mth101'>",
  "quantity": <the number of files to retrieve and send, decided by user request (default is 5 if unspecified)>,
  "context_terms": ["<optional search filter terms like 'final', 'handout'>"],
  "exclude_terms": ["<optional search exclusion terms like 'midterm'>"],
  "reply": "<short confirmation message confirming the files are being searched and sent>"
}

Format 3: Add Admin (Only for ADMIN users requesting to add a new number)
{
  "type": "add_admin",
  "newNumber": "<the number to add>",
  "reply": "<confirmation message>"
}

### CONVERSATION EXAMPLES (HOW YOU MUST BEHAVE):

Example 1: First request for course files
User: "hi, can you send me cs302 handouts?"
Assistant Output:
{
  "type": "chat",
  "reply": "I can help you search for CS302 files. Do you want me to proceed with the search? Also, how many files do you need, and are they for midterms or final exams?"
}

Example 2: User responds and confirms the details (History shows Turn 1 completed)
User: "yes please search, send me 3 files for final term prep"
Assistant Output:
{
  "type": "send_file",
  "search_query": "cs302",
  "quantity": 3,
  "context_terms": ["final", "prep"],
  "exclude_terms": ["midterm"],
  "reply": "Searching for 3 CS302 final term files now. Please wait..."
}

Example 3: General conversational message
User: "how are you today?"
Assistant Output:
{
  "type": "chat",
  "reply": "I am doing great, thank you! How can I assist you with your Virtual University studies today?"
}

Output EXACTLY ONE valid JSON object conforming to one of the formats above. Do NOT output any introductory text, titles, markdown blocks, formatting headers, or multiple examples. Your output must start directly with '{' and end directly with '}'.`;

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${AI_MODEL}`;
  console.log(`\n--- Test User Message: "${userMessage}" ---`);
  
  const historyMessages = history.map(msg => ({
    role: msg.direction === 'incoming' ? 'user' : 'assistant',
    content: msg.text
  }));

  let content = '';
  try {
    const response = await axios.post(
      url,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: userMessage }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const data = response.data;
    content = data?.result?.choices?.[0]?.message?.content ?? data?.result?.response;
    console.log("Raw Response:", content);

    // Try parsing
    let cleanResponse = content.trim();
    const firstBrace = cleanResponse.indexOf('{');
    const lastBrace = cleanResponse.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleanResponse = cleanResponse.slice(firstBrace, lastBrace + 1);
    } else {
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      }
      if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```\n?/, '').replace(/\n?```$/, '');
      }
    }
    const parsed = JSON.parse(cleanResponse);
    console.log("Parsed JSON:", JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (error) {
    console.log("Fallback representation (if any text):", content);
    console.error(`Failed to parse response as JSON: ${error.message}`);
    return { type: 'chat', reply: content };
  }
}

async function main() {
  console.log("=== SIMULATING MULTI-TURN CONVERSATION ===");
  const history = [];

  // Turn 1: User requests files for CS302. AI should not search, but ask questions first.
  const msg1 = "give me cs302 files";
  const res1 = await testUserIntent(msg1, history);
  history.push({ direction: 'incoming', text: msg1 });
  history.push({ direction: 'outgoing', text: res1.reply || JSON.stringify(res1) });

  // Turn 2: User answers the AI questions and confirms. AI should now search.
  const msg2 = "Yes please search, I want 3 final term papers for cs302";
  const res2 = await testUserIntent(msg2, history);
}

main();
