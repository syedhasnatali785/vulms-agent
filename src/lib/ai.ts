import axios from 'axios';
import { getAvailableFiles } from './supabase';
import { isMidtermFile, isFinalTermFile } from './fileFilters';

const AI_MODEL = process.env.CLOUDFLARE_AI_MODEL || '@cf/qwen/qwen3-30b-a3b-fp8';

const CLOUDFLARE_ACCOUNTS = [
  // Primary (from environment variables)
  {
    id: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CLOUDFLARE_API_TOKEN || '',
  },
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

/**
 * We use Cloudflare Workers AI via REST API because Vercel Serverless
 * does not support the native Cloudflare Workers bindings.
 * If one account fails or limit is reached, it automatically falls back to subsequent ones.
 */
export async function runCloudflareAI(messages: any[]): Promise<string> {
  const activeAccounts = CLOUDFLARE_ACCOUNTS.filter(acc => acc.id && acc.token);

  if (activeAccounts.length === 0) {
    throw new Error('No Cloudflare AI accounts are configured (missing ID or Token).');
  }

  let lastError: any = null;

  for (let i = 0; i < activeAccounts.length; i++) {
    const acc = activeAccounts[i];
    const url = `https://api.cloudflare.com/client/v4/accounts/${acc.id}/ai/run/${AI_MODEL}`;

    try {
      console.log(`[Cloudflare AI] Attempting API call with Account ${i + 1}/${activeAccounts.length} (ID: ${acc.id})...`);
      const response = await axios.post(
        url,
        { messages },
        {
          headers: {
            Authorization: `Bearer ${acc.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 25000, // 25s
        }
      );

      // Cloudflare can return 200 with { success: false, result: {}, errors: [...] }
      const data = response.data;
      if (!data?.success) {
        console.error(`[Cloudflare AI] Account ${i + 1} returned unsuccessful response:`, JSON.stringify(data));
        throw new Error(`Cloudflare AI error: success=${data?.success}, errors=${JSON.stringify(data?.errors || [])}`);
      }

      // Try standard choices format first, then fall back to response field
      const content = data?.result?.choices?.[0]?.message?.content ?? data?.result?.response;
      if (content === undefined || content === null) {
        console.error(`[Cloudflare AI] Account ${i + 1} did not return a response/content:`, JSON.stringify(data));
        throw new Error(`Cloudflare AI error: No response content found in result.`);
      }

      // Ensure content returned is a string
      if (typeof content === 'object') {
        return JSON.stringify(content);
      }
      return String(content);
    } catch (error: any) {
      const status = error.response?.status;
      const errData = error.response?.data;
      console.error(`[Cloudflare AI] Account ${i + 1} failed (status=${status}):`, errData || error.message);
      lastError = error;
      console.log(`[Cloudflare AI] Account ${i + 1} failed. Trying next configured account...`);
    }
  }

  const status = lastError?.response?.status;
  const errMsg = lastError?.response?.data || lastError?.message;
  throw new Error(`All Cloudflare AI accounts failed. Last error: status=${status}, detail=${JSON.stringify(errMsg)}`);
}

/**
 * Given a user's message, this function decides what the agent should do.
 * It injects the list of available files into the prompt.
 *
 * Possible Intent Returns:
 * { type: 'chat', reply: '...' }
 * { type: 'send_file', search_query: '...', quantity: N, context_terms: [...], exclude_terms: [...], reply: '...' }
 * { type: 'send_files', searches: [...], reply: '...' }
 * { type: 'keyword_search', keywords: [...], reply: '...' }  ← broad DB keyword search, returns all matches
 * { type: 'add_admin', newNumber: '...', reply: '...' }
 */
export async function processUserIntent(userMessage: string, isAdmin: boolean, history: any[] = []) {
  let files = await getAvailableFiles();
  if (!isAdmin) {
    files = files.filter((f: any) => !isMidtermFile(f.filename) && isFinalTermFile(f.filename));
  }
  const fileNames = files.map((f: any) => `${f.filename} (ID: ${f.id})`).join(', ');

  const systemPrompt = `you're **SYED 1.2**, an AI Model built by **Syed Hasnat Ali**.

you evaluate student messages and decide the appropriate action. Stick to student queries regarding study and materials. Do not be irrelevant you're built only for studies donot provide guides.always use roman urdu.never ask student his/her personal details.
You can send users documents/videos/images that have been uploaded to our database or are available in our Database directories.

The user's role is: ${isAdmin ? 'ADMIN' : 'STANDARD USER'}.
Available database files right now: ${fileNames ? fileNames : 'None'}.

### OPERATIONAL WORKFLOW FOR FILE REQUESTS:
Follow these steps in sequence when a student asks for files, handouts, or past papers:
- **Step 1 (Clarification & Confirmation)**: If the conversation history does NOT show that you already asked for confirmation and details, reply using **Format 1 (Chat)**. Ask if they want to search, how many files per course.
- **Step 2 (Trigger Search)**: Once the user has confirmed or did reply, use **Format 2** (single course) or **Format 3** (multiple courses at once).

### ADDITIONAL RULES:
- Do NOT list or simulate file results in your text. The server handles searching via Database and Database APIs.
- We have thousands of VU files for ALL courses in Database, so you can always search any course code.
- When the user provides a list of multiple course codes in one message (e.g., "EDU303, EDU401, CS302"), always use **Format 3 (Multiple Searches)**.
- If files doesnt found ask student to use @all course code example: @all cs101. this will must search all files of that course.
### RESPONSE FORMATS (MUST OUTPUT ONLY VALID JSON):

Format 1: Chat / Confirmation Request
{
  "type": "chat",
  "reply": "<your friendly response or question to clarify details>"
}

Format 2: Single Course File Search (one course confirmed)
{
  "type": "send_file",
  "search_query": "<course code, e.g. 'cs302'>",
  "quantity": <number of files reque  sted by user (or 15 if unspecified)>,
  "context_terms": ["<e.g. 'final', 'handout'>"],
  "exclude_terms": ["<e.g. 'midterm'>"],
  "reply": "<short confirmation message>"
}

Format 3: Multiple Courses File Search (when user lists multiple course codes).unspecified quantity if not given then 10 as default for each course  
{
  "type": "send_files",
  "searches": [
    { "search_query": "<course_code_1>", "quantity": <N>, "context_terms": [...], "exclude_terms": [...] },
    { "search_query": "<course_code_2>", "quantity": <N>, "context_terms": [...], "exclude_terms": [...] }
  ],
  "reply": "<short confirmation mentioning all courses being searched>"
}

Format 4: Add Admin (ADMIN users only)
{
  "type": "add_admin",
  "newNumber": "<the number to add>",
  "reply": "<confirmation message>"
}

Format 5: Keyword Search Tool — Broad DB Search (use when student says "search all", "show everything", "har file do", or explicitly wants ALL available files for a topic without a quantity limit)
{
  "type": "keyword_search",
  "keywords": ["<keyword1>", "<keyword2>"],
  "reply": "<confirmation message>"
}

### CONVERSATION EXAMPLES:

Example 1: First single-course request (no prior confirmation in history)
User: "give me cs302 handouts"
Assistant Output:
{
  "type": "chat",
  "reply": "CS302 ke liye search kar sakta hoon. Kitni files chahiye aur midterm ya final term ke liye hain?"
}

Example 2: User confirms single course (history shows Step 1 was done)
User: "yes 3 final term files"
Assistant Output:
{
  "type": "send_file",
  "search_query": "cs302",
  "quantity": 3,
  "context_terms": ["final"],
  "exclude_terms": ["midterm"],
  "reply": "CS302 ke 3 final term files search ho rahi hain, please wait..."
}

Example 3: User sends multiple course codes at once (no prior confirmation needed — treat as implicit confirmation)
User: "EDU303\nEDU401\nEDU410\nEDU430\nEDU515\nENG201 send me all"
Assistant Output:
{
  "type": "send_files",
  "searches": [
    { "search_query": "EDU303", "quantity": 3, "context_terms": [], "exclude_terms": [] },
    { "search_query": "EDU401", "quantity": 3, "context_terms": [], "exclude_terms": [] },
    { "search_query": "EDU410", "quantity": 3, "context_terms": [], "exclude_terms": [] },
    { "search_query": "EDU430", "quantity": 3, "context_terms": [], "exclude_terms": [] },
    { "search_query": "EDU515", "quantity": 3, "context_terms": [], "exclude_terms": [] },
    { "search_query": "ENG201", "quantity": 3, "context_terms": [], "exclude_terms": [] }
  ],
  "reply": "6 courses ke files search ho rahi hain (EDU303, EDU401, EDU410, EDU430, EDU515, ENG201). Please wait..."
}

Example 4: General conversation
User: "how are you?"
Assistant Output:
{
  "type": "chat",
  "reply": "Main theek hoon, shukriya! VU studies mein kaise help kar sakta hoon?"
}

Example 5: Student explicitly wants ALL files / broad search
User: "cs302 ki sari files do" (or "show everything for cs302", "har file chahiye")
Assistant Output:
{
  "type": "keyword_search",
  "keywords": ["cs302"],
  "reply": "CS302 ki tamam files search ho rahi hain, please wait..."
}

Output EXACTLY ONE valid JSON object. Do NOT add any text before or after the JSON. Start directly with '{' and end with '}'.`;

  const historyMessages = history.map((msg: any) => ({
    role: msg.direction === 'incoming' ? 'user' : 'assistant',
    content: msg.text
  }));

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage }
  ];

  const aiResponse = await runCloudflareAI(messages);

  try {
    let cleanResponse = aiResponse.trim();
    // Resilient parsing: extract JSON block if wrapped in explanation or markdown prefix
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
    if (parsed && typeof parsed === 'object') {
      if (parsed.reply && typeof parsed.reply === 'object') {
        parsed.reply = JSON.stringify(parsed.reply);
      }
      return parsed;
    }
    return { type: 'chat', reply: cleanResponse };
  } catch (e) {
    console.error("Failed to parse AI JSON response:", aiResponse);
    const replyText = typeof aiResponse === 'object' ? JSON.stringify(aiResponse) : String(aiResponse || '');
    return { type: 'chat', reply: replyText || 'Mujhe samajh nahi aaya, please dobara try karein.' };
  }
}

/**
 * Asks the AI to determine whether an admin's text message is a "Paper Current Review" —
 * i.e. a description / report of questions that appeared in an actual exam.
 *
 * Returns:
 *   { is_review: boolean, course_codes: string[], reason: string }
 */
export async function classifyAdminReview(
  text: string
): Promise<{ is_review: boolean; course_codes: string[]; reason: string }> {
  const systemPrompt = `You are a strict classifier for a university study-material bot.
Your ONLY job is to decide whether the admin's text message is a "Current Paper Review" — meaning it describes, summarises, or reports questions / MCQs / topics that appeared in a real university exam paper.

Rules:
- Treat it as a review ONLY if the message clearly discusses exam questions, MCQs, topics that were asked, or the difficulty of a specific exam.
- If the message is a general command, greeting, question, admin instruction, or anything else — it is NOT a review.
- Course codes look like CS302, MTH101, ENG201, etc. Extract ALL course codes mentioned.

Reply with EXACTLY ONE valid JSON object — no extra text:
{
  "is_review": true | false,
  "course_codes": ["CS302"],   // list of detected course codes, empty array if none
  "reason": "brief one-line reason"
}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: text }
  ];

  try {
    const raw = await runCloudflareAI(messages);
    let clean = raw.trim();
    const f = clean.indexOf('{');
    const l = clean.lastIndexOf('}');
    if (f !== -1 && l > f) clean = clean.slice(f, l + 1);
    const parsed = JSON.parse(clean);
    return {
      is_review: parsed.is_review === true,
      course_codes: Array.isArray(parsed.course_codes) ? parsed.course_codes : [],
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error('classifyAdminReview: Failed to parse AI response:', err);
    // Conservative fallback: do not save if AI is uncertain
    return { is_review: false, course_codes: [], reason: 'AI classification failed' };
  }
}

