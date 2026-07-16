import axios from 'axios';
import { getAvailableFiles } from './supabase';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * We use Cloudflare Workers AI via REST API because Vercel Serverless
 * does not support the native Cloudflare Workers bindings.
 */
export async function runCloudflareAI(messages: any[]) {
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
      }
    );
    return response.data.result.response;
  } catch (error: any) {
    console.error('Error running Cloudflare AI:', error.response?.data || error.message);
    throw error;
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
export async function processUserIntent(userMessage: string, isAdmin: boolean) {
  const files = await getAvailableFiles();
  const fileNames = files.map((f: any) => `${f.filename} (ID: ${f.id})`).join(', ');

  let systemPrompt = `You are a helpful WhatsApp AI agent. 
You can send users documents/videos/images that have been uploaded to Cloudflare R2.
Available files right now: ${fileNames ? fileNames : 'None'}.

The user's role is: ${isAdmin ? 'ADMIN' : 'STANDARD USER'}.

If the user asks for a file (either by its filename, its database ID, or its message ID), format your response exactly as JSON:
{ "type": "send_file", "filename": "<exact_filename_or_id_or_message_id_requested>", "reply": "<short message to accompany the file>" }

If an ADMIN user asks to add a new admin (e.g., "add admin 1234567890"), format exactly as JSON:
{ "type": "add_admin", "newNumber": "<the_number_to_add>", "reply": "<confirmation message>" }
Note: Only ADMINs can add admins. If a STANDARD USER asks this, politely decline as a normal chat.

Otherwise, just answer normally as JSON:
{ "type": "chat", "reply": "<your response here>" }

Output ONLY valid JSON. No markdown formatting blocks around it.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  const aiResponse = await runCloudflareAI(messages);
  
  try {
    // Attempt to parse JSON response. Cloudflare's Llama-3-8b-instruct might wrap it in markdown.
    let cleanResponse = aiResponse.trim();
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\n/, '').replace(/\n```$/, '');
    }
    return JSON.parse(cleanResponse);
  } catch (e) {
    console.error("Failed to parse AI JSON response:", aiResponse);
    return { type: 'chat', reply: "I didn't quite catch that. Can you rephrase?" };
  }
}
