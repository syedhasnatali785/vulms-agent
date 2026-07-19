import axios from 'axios';
import { getAvailableFiles } from './supabase';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const AI_MODEL = process.env.CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.2-1b-instruct';

/**
 * We use Cloudflare Workers AI via REST API because Vercel Serverless
 * does not support the native Cloudflare Workers bindings.
 */
export async function runCloudflareAI(messages: any[]): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${AI_MODEL}`;

  try {
    const response = await axios.post(
      url,
      { messages },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 8000, // 8s timeout to stay within Vercel's 10s limit
      }
    );

    // Cloudflare can return 200 with { success: false, result: {}, errors: [...] }
    const data = response.data;
    if (!data?.success) {
      console.error('Cloudflare AI returned unsuccessful response:', JSON.stringify(data));
      throw new Error(`Cloudflare AI error: success=${data?.success}, errors=${JSON.stringify(data?.errors || [])}`);
    }

    // Try standard choices format first, then fall back to response field
    const content = data?.result?.choices?.[0]?.message?.content ?? data?.result?.response;
    if (content === undefined || content === null) {
      console.error('Cloudflare AI did not return a response/content:', JSON.stringify(data));
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
    console.error(`Cloudflare AI error (status=${status}):`, errData || error.message);
    throw new Error(`Cloudflare AI failed: status=${status}, message=${error.message}`);
  }
}

/**
 * Given a user's message, this function decides what the agent should do.
 * It injects the list of available files into the prompt.
 * 
 * Possible Intent Returns:
 * { type: 'chat', reply: '...message...' }
 * { type: 'send_file', filename: '...', reply: '...' }
 * { type: 'add_admin', newNumber: '...', reply: '...' }
 */
export async function processUserIntent(userMessage: string) {
  const files = await getAvailableFiles();
  const fileNames = files.map((f: any) => `${f.filename} (ID: ${f.id})`).join(', ');

  const systemPrompt = `You are **SYED 1.2**, a helpful AI assistant built by **Syed Hasnat Ali** to help Virtual University students find study materials, handouts, and course files.

You must validate the user's message and determine their intent. You must output ONLY a valid JSON object. No other text or markdown wrapping is allowed.

Possible intents are:
1. "search_batch": The user is requesting materials, documents, files, past papers, or handouts for one or more courses/files.
   Validate that the user is actually requesting course codes or files. If they are, extract each course/file request into a structured list.
   
   IMPORTANT Guidelines for Extraction:
   - If the user asks for files of specific course codes (e.g., "mth301", "cs502"), extract the course code (e.g., "mth301") as "courseCode" and any context keywords (like "handouts", "final", "solved") as "contextTerms".
   - If the user specifies or pastes a specific filename or file name with extension (for example: "CS601 FINAL TERM FILE 2 SOLVED BY HADI.pdf" or "mth101_past_papers.pdf"), extract the full filename EXACTLY as the "courseCode" and leave "contextTerms" empty.
   
   Format:
   {
     "type": "search_batch",
     "requests": [
       { "courseCode": "<extracted course code or exact filename/id>", "contextTerms": [<optional list of context keywords like "final", "mid", "handout", "highlight", "past", "paper", "solved">] }
     ],
     "reply": "<friendly confirmation message acknowledging the search requests>"
   }

2. "chat": The user is greeting you, asking conversational questions, saying thanks, or the query is not asking for files/courses.
   Format:
   {
     "type": "chat",
     "reply": "<your friendly, conversational response in Urdu/English mix, aligned with your persona>"
   }

Available files right now in database: ${fileNames ? fileNames : 'None'}.

Examples:
- User: "Acha sta301,mth401,mcm301,cs502 ki sab files send krdo"
  Response: { "type": "search_batch", "requests": [{ "courseCode": "sta301", "contextTerms": [] }, { "courseCode": "mth401", "contextTerms": [] }, { "courseCode": "mcm301", "contextTerms": [] }, { "courseCode": "cs502", "contextTerms": [] }], "reply": "Sure, searching files for STA301, MTH401, MCM301, and CS502. Please wait a moment..." }

- User: "please provide me this file: CS601 FINAL TERM FILE 2 SOLVED BY HADI.pdf"
  Response: { "type": "search_batch", "requests": [{ "courseCode": "CS601 FINAL TERM FILE 2 SOLVED BY HADI.pdf", "contextTerms": [] }], "reply": "Analyzing and searching for CS601 FINAL TERM FILE 2 SOLVED BY HADI.pdf..." }

- User: "CS101 key handouts and midterm solved papers send krdo"
  Response: { "type": "search_batch", "requests": [{ "courseCode": "cs101", "contextTerms": ["handout", "midterm", "solved", "paper"] }], "reply": "Searching for CS101 handouts and midterm solved papers..." }

- User: "hi how are you"
  Response: { "type": "chat", "reply": "👋 Hello! Main SYED 1.2 hoon. Aapko kis course ke handouts ya past papers chahiye? Mujhe course code batayein (jaise CS101)." }

Output ONLY valid JSON. No markdown blocks.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  const aiResponse = await runCloudflareAI(messages);

  try {
    // Attempt to parse JSON response. The model might wrap it in markdown.
    let cleanResponse = aiResponse.trim();
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }
    if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```\n?/, '').replace(/\n?```$/, '');
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
    // Return the raw text as a chat reply so the user still gets a response
    const replyText = typeof aiResponse === 'object' ? JSON.stringify(aiResponse) : String(aiResponse || '');
    return { type: 'chat', reply: replyText || "I didn't quite catch that. Can you rephrase?" };
  }
}
