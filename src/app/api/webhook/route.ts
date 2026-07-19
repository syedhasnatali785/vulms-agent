import { NextResponse } from 'next/server';
import { saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage, saveLog } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage } from '@/lib/whatsapp';
import { uploadFileToR2, getFileUrl } from '@/lib/r2';
import { processUserIntent } from '@/lib/ai';
import { searchGDriveFiles } from '@/lib/gdrive';

export const maxDuration = 10;
export const dynamic = 'force-dynamic';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// In-memory deduplication cache
const processedMessageIds = new Set<string>();
const MAX_CACHE_SIZE = 1000;

function isDuplicateMessage(messageId: string): boolean {
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_CACHE_SIZE) {
    const oldest = processedMessageIds.values().next().value;
    if (oldest) processedMessageIds.delete(oldest);
  }
  return false;
}

// In-memory logs buffer for dashboard
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}
const logsBuffer: LogEntry[] = [];
const MAX_LOGS = 200;

function addLog(level: 'info' | 'warn' | 'error', message: string) {
  logsBuffer.unshift({ timestamp: new Date().toISOString(), level, message });
  if (logsBuffer.length > MAX_LOGS) logsBuffer.pop();

  // Log asynchronously to Supabase logs table (non-blocking)
  saveLog(level, message).catch(() => { });
}

export function getLogs(): LogEntry[] {
  return logsBuffer;
}

// Conversational stop-words
const CONVERSATIONAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'hlo', 'hy', 'assalam', 'o', 'alaikum', 'aoa', 'ws', 'salam',
  'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'g', 'ji', 'haan', 'fine',
  'thanks', 'thank', 'thankyou', 'welcome',
  'please', 'pls', 'help', 'info', 'test', 'status',
  'admin', 'agent', 'bot', 'good', 'morning', 'afternoon', 'evening'
]);

function isConversationalQuery(text: string): boolean {
  const clean = text.toLowerCase().trim().replace(/[?.!,]/g, '');
  if (!clean) return true;
  if (CONVERSATIONAL_WORDS.has(clean)) return true;
  return clean.split(/\s+/).every(w => CONVERSATIONAL_WORDS.has(w));
}

/**
 * SMART keyword extraction: extracts subject code + context terms from user message.
 * Example: "cs405 finale term files send kar do"
 *   → courseCode: "cs405"
 *   → contextTerms: ["final"] (normalized from "finale")
 *   → Drive search: name contains 'cs405' AND name contains 'final'
 */
function extractSmartSearchParams(text: string): { courseCode: string | null; contextTerms: string[]; excludeTerms: string[] } {
  const lowerText = text.toLowerCase();

  // Extract course code (letters + digits pattern like cs405, eng201)
  const codeMatch = lowerText.match(/\b([a-z]{2,5})\s*[-_]?\s*(\d{2,4})\b/);
  const courseCode = codeMatch ? `${codeMatch[1]}${codeMatch[2]}` : null;

  const terms: string[] = [];

  const wantsFinal = lowerText.includes('final');
  const wantsMid = lowerText.includes('mid');

  if (courseCode) {
    // Split message into words using standard separators
    const words = lowerText.split(/[\s,._-]+/);
    for (const word of words) {
      if (word.includes('final') || word.includes('mid') || word.includes('handout') || word.includes('highlight')) {
        // Add the exact word typed by the user (e.g., 'finale', 'mids')
        terms.push(word);

        // Also add standard normalized root terms to maximize hits
        if (word.includes('final') && word !== 'final') {
          terms.push('final');
        }
        if (word.includes('mid') && word !== 'mid' && word !== 'midterm') {
          terms.push('mid');
          terms.push('midterm');
        }
        if (word.includes('handout') && word !== 'handout') {
          terms.push('handout');
        }
        if (word.includes('highlight') && word !== 'highlight') {
          terms.push('highlight');
        }
      }
    }
  }

  // Build exclusion list:
  // If user wants final but NOT mid → exclude midterm/mid files
  // If user wants mid but NOT final → exclude final files  
  const excludeTerms: string[] = [];
  if (wantsFinal && !wantsMid) {
    excludeTerms.push('mid', 'midterm');
  } else if (wantsMid && !wantsFinal) {
    excludeTerms.push('final', 'finalterm');
  }

  // Deduplicate matched terms
  const uniqueTerms = Array.from(new Set(terms));
  return { courseCode, contextTerms: uniqueTerms, excludeTerms };
}

/** Helper: sends a text message and logs it to Supabase + in-memory logs */
async function sendAndLogTextMessage(to: string, text: string) {
  await sendTextMessage(to, text);
  await saveMessage(to, text, 'outgoing');
  addLog('info', `→ Bot to ${to}: ${text.substring(0, 100)}`);
}

async function sendFileToUser(sender: string, file: any) {
  if (file.filename.toLowerCase().includes('midterm')) {
    addLog('warn', `Blocked sending file "${file.filename}" because it contains "midterm"`);
    return;
  }
  const fileUrl = await getFileUrl(file.r2_key);
  const mediaType = file.mime_type.startsWith('image') ? 'image'
    : file.mime_type.startsWith('video') ? 'video'
      : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.filename, '(By SYED BOT)');
  addLog('info', `→ Sent file "${file.filename}" to ${sender}`);
}

async function sendGDriveFileToUser(sender: string, file: any) {
  if (file.name.toLowerCase().includes('midterm')) {
    addLog('warn', `Blocked sending GDrive file "${file.name}" because it contains "midterm"`);
    return;
  }
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${process.env.GOOGLE_API_KEY}`;
  const mediaType = file.mimeType.startsWith('image') ? 'image'
    : file.mimeType.startsWith('video') ? 'video'
      : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.name, '(By SYED BOT)');
  addLog('info', `→ Sent GDrive file "${file.name}" to ${sender}`);
}

async function executeSearchRequest(sender: string, query: string, contextTerms: string[], excludeTerms: string[]): Promise<boolean> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return false;

  // 1. Direct file ID/name/message_id check first (for any query length)
  if (!isConversationalQuery(cleanQuery)) {
    const dbFile = await getFileByIdOrNameOrMessageId(cleanQuery);
    if (dbFile && !dbFile.filename.toLowerCase().includes('midterm')) {
      try {
        await sendAndLogTextMessage(sender, `Found file: ${dbFile.filename}`);
        await sendFileToUser(sender, dbFile);
        return true;
      } catch (err: any) {
        addLog('error', `Direct file send error: ${err.message}`);
      }
    }

    // Direct Google Drive search first on the full query
    const driveFiles = await searchGDriveFiles(cleanQuery);
    const filteredDriveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
    if (filteredDriveFiles.length > 0) {
      try {
        await sendAndLogTextMessage(sender, `Found: ${filteredDriveFiles[0].name}`);
        await sendGDriveFileToUser(sender, filteredDriveFiles[0]);
        return true;
      } catch (err: any) {
        addLog('error', `Direct GDrive send error: ${err.message}`);
      }
    }
  }

  // 2. Regular Keyword/Smart Search (Supabase) with fallback: split the query if direct search didn't find anything
  const { courseCode, contextTerms: parsedContext, excludeTerms: parsedExclude } = extractSmartSearchParams(cleanQuery);
  const searchKeywords = courseCode ? [courseCode] : [cleanQuery];
  const mergedContext = Array.from(new Set([...contextTerms, ...parsedContext]));
  const mergedExclude = Array.from(new Set([...excludeTerms, ...parsedExclude]));

  let dbFiles = await getFilesByKeywords(searchKeywords, mergedContext);
  dbFiles = dbFiles.filter(f => !f.filename.toLowerCase().includes('midterm'));
  if (mergedExclude.length > 0) {
    dbFiles = dbFiles.filter(f => !mergedExclude.some(ex => f.filename.toLowerCase().includes(ex)));
  }
  addLog('info', `Supabase: ${dbFiles.length} files for keywords=[${searchKeywords}] context=[${mergedContext}]`);

  // 3. Regular Keyword/Smart Search (Google Drive)
  let driveFiles = await searchGDriveFiles(searchKeywords[0], mergedContext);
  driveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
  if (mergedExclude.length > 0) {
    driveFiles = driveFiles.filter(f => !mergedExclude.some(ex => f.name.toLowerCase().includes(ex)));
  }
  addLog('info', `GDrive: ${driveFiles.length} files for keywords=[${searchKeywords}] context=[${mergedContext}]`);

  const totalCount = dbFiles.length + driveFiles.length;
  if (totalCount > 0) {
    const contextLabel = mergedContext.length > 0 ? `(${mergedContext.join(', ')})` : '';
    const excludeLabel = mergedExclude.length > 0 ? ` [excluding: ${mergedExclude.join(', ')}]` : '';
    await sendAndLogTextMessage(sender, `Found ${totalCount} file(s) for "${cleanQuery}" ${contextLabel}${excludeLabel}:`);

    for (const file of dbFiles) {
      try { await sendFileToUser(sender, file); } catch (err: any) {
        addLog('error', `Failed sending DB file: ${err.message}`);
      }
    }
    for (const file of driveFiles) {
      try { await sendGDriveFileToUser(sender, file); } catch (err: any) {
        addLog('error', `Failed sending GDrive file: ${err.message}`);
      }
    }
    return true;
  }

  return false;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.object !== 'whatsapp_business_account') {
      return new NextResponse('Not a WhatsApp event', { status: 404 });
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages || [];

    if (messages.length === 0) {
      return new NextResponse('OK', { status: 200 });
    }

    // Process all messages concurrently
    const processPromises = messages.map(async (message: any) => {
      const messageId = message.id;
      if (messageId && isDuplicateMessage(messageId)) return;

      const sender = message.from;
      addLog('info', `← Message from ${sender}: type=${message.type}`);

      const MEDIA_TYPES = ['image', 'video', 'document', 'audio', 'voice', 'sticker'];

      // 1. Handle Media Uploads
      if (MEDIA_TYPES.includes(message.type)) {
        const mediaId = message[message.type]?.id;
        const caption = message[message.type]?.caption || '';

        if (mediaId) {
          try {
            await sendAndLogTextMessage(sender, `Downloading and saving your ${message.type}...`);
            const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);

            let rawFilename = '';
            if (message.type === 'document' && message.document?.filename) {
              rawFilename = message.document.filename;
            } else {
              rawFilename = caption || `file_${Date.now()}`;
            }

            const ext = mimeType.split('/')[1] || 'bin';
            const safeExt = ext.split(';')[0] || 'bin';
            let filename = rawFilename.replace(/\s+/g, '_');
            if (!filename.toLowerCase().endsWith(`.${safeExt.toLowerCase()}`)) {
              if (mimeType === 'application/pdf' && !filename.toLowerCase().endsWith('.pdf')) {
                filename = `${filename}.pdf`;
              } else {
                filename = `${filename}.${safeExt}`;
              }
            }

            const r2Key = `uploads/${filename}`;
            await uploadFileToR2(r2Key, buffer, mimeType);
            const savedFile = await saveFileMetadata(filename, r2Key, mimeType, sender);

            let msg = `File saved! 📂 ${filename}`;
            if (savedFile) msg += ` (ID: ${savedFile.id})`;
            await sendAndLogTextMessage(sender, msg);
          } catch (e: any) {
            addLog('error', `Upload failed for ${sender}: ${e.message}`);
            await sendAndLogTextMessage(sender, "Failed to process the upload.");
          }
        }

        if (!caption.trim()) return;
        message.type = 'text';
        message.text = { body: caption.trim() };
      }

      // 2. Handle Text Messages
      if (message.type === 'text') {
        const text = message.text.body.trim();
        await saveMessage(sender, text, 'incoming');
        addLog('info', `← ${sender}: "${text}"`);

        // AI Validation and Intent Classification
        let intent;
        try {
          intent = await processUserIntent(text);
          addLog('info', `AI intent: ${intent.type}`);
        } catch (aiErr: any) {
          addLog('error', `AI error: ${aiErr.message}. Using fallback regex extraction.`);
          
          // Regex-based Fallback
          const { courseCode, contextTerms } = extractSmartSearchParams(text);
          if (courseCode) {
            intent = {
              type: 'search_batch',
              requests: [{ courseCode, contextTerms }],
              reply: `AI was offline, but I'm searching for files matching "${courseCode}"...`
            };
          } else {
            intent = {
              type: 'chat',
              reply: "👋Welcome Im  SYED 1.2 , an AI language model built by  Syed Hasnat Ali  📚 Simply send me a  course code  (for example:  CS101 ,  MTH101 , or  ENG201*), and I'll process your request and do my best to provide the relevant files and study materials."
            };
          }
        }

        switch (intent.type) {
          case 'search_batch':
            if (intent.reply) {
              await sendAndLogTextMessage(sender, intent.reply);
            }
            if (Array.isArray(intent.requests) && intent.requests.length > 0) {
              // Process requests in a queue (sequentially)
              for (let i = 0; i < intent.requests.length; i++) {
                const req = intent.requests[i];
                const query = req.courseCode || req.query || '';
                const contextTerms = req.contextTerms || [];

                // Standard exclusion logic for mid/final terms
                const wantsFinal = text.toLowerCase().includes('final') || contextTerms.some((t: string) => t.toLowerCase().includes('final'));
                const wantsMid = text.toLowerCase().includes('mid') || contextTerms.some((t: string) => t.toLowerCase().includes('mid'));
                const excludeTerms: string[] = [];
                if (wantsFinal && !wantsMid) {
                  excludeTerms.push('mid', 'midterm');
                } else if (wantsMid && !wantsFinal) {
                  excludeTerms.push('final', 'finalterm');
                }

                addLog('info', `Queue item [${i + 1}/${intent.requests.length}]: searching for "${query}"`);
                const found = await executeSearchRequest(sender, query, contextTerms, excludeTerms);
                if (!found) {
                  await sendAndLogTextMessage(sender, `Sorry, no files found for "${query}".`);
                }

                // Add 1.5s delay between queue items to prevent rate limits or messages getting out of order
                if (i < intent.requests.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 1500));
                }
              }
            }
            break;

          case 'send_file':
            if (intent.filename) {
              const { contextTerms } = extractSmartSearchParams(text);
              const dbFile = await getFileByIdOrNameOrMessageId(intent.filename);
              if (dbFile && !dbFile.filename.toLowerCase().includes('midterm')) {
                await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                await sendFileToUser(sender, dbFile);
              } else {
                const driveFiles = await searchGDriveFiles(intent.filename, contextTerms);
                const filteredDriveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
                if (filteredDriveFiles.length > 0) {
                  await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                  await sendGDriveFileToUser(sender, filteredDriveFiles[0]);
                } else {
                  await sendAndLogTextMessage(sender, `Sorry, couldn't find "${intent.filename}".`);
                }
              }
            }
            break;

          case 'chat':
          default:
            await sendAndLogTextMessage(sender, intent.reply || "I'm not sure how to help with that.");
            break;
        }
      }
    });

    await Promise.all(processPromises);
    return new NextResponse('OK', { status: 200 });
  } catch (error: any) {
    addLog('error', `Webhook crash: ${error.message}`);
    console.error('Webhook Error:', error);
    return new NextResponse('OK', { status: 200 });
  }
}
