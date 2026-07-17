import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage, saveLog } from '@/lib/supabase';
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
  saveLog(level, message).catch(() => {});
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
  const fileUrl = await getFileUrl(file.r2_key);
  const mediaType = file.mime_type.startsWith('image') ? 'image'
                   : file.mime_type.startsWith('video') ? 'video'
                   : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.filename);
  addLog('info', `→ Sent file "${file.filename}" to ${sender}`);
}

async function sendGDriveFileToUser(sender: string, file: any) {
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${process.env.GOOGLE_API_KEY}`;
  const mediaType = file.mimeType.startsWith('image') ? 'image'
                   : file.mimeType.startsWith('video') ? 'video'
                   : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.name);
  addLog('info', `→ Sent GDrive file "${file.name}" to ${sender}`);
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

      const isSenderAdmin = await isAdmin(sender);
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

        // Skip greetings
        if (isConversationalQuery(text)) {
          addLog('info', `Greeting detected, skipping file search for "${text}"`);
          // Fall through to AI
        } else {
          // Smart extraction: "cs405 finale term files send kar do" → code=cs405, context=[final], exclude=[mid]
          const { courseCode, contextTerms, excludeTerms } = extractSmartSearchParams(text);
          addLog('info', `Extracted: code=${courseCode}, context=[${contextTerms}], exclude=[${excludeTerms}]`);

          if (courseCode) {
            try {
              // Search Supabase
              let dbFiles = await getFilesByKeywords([courseCode], contextTerms);
              // Apply exclusion filter: remove files whose name contains any excluded term
              if (excludeTerms.length > 0) {
                const before = dbFiles.length;
                dbFiles = dbFiles.filter(f => !excludeTerms.some(ex => f.filename.toLowerCase().includes(ex)));
                if (before !== dbFiles.length) addLog('info', `Excluded ${before - dbFiles.length} DB midterm/final file(s)`);
              }
              addLog('info', `Supabase: ${dbFiles.length} files for "${courseCode}"`);

              // Search Google Drive
              let driveFiles = await searchGDriveFiles(courseCode, contextTerms);
              // Apply exclusion filter: remove files whose name contains any excluded term
              if (excludeTerms.length > 0) {
                const before = driveFiles.length;
                driveFiles = driveFiles.filter(f => !excludeTerms.some(ex => f.name.toLowerCase().includes(ex)));
                if (before !== driveFiles.length) addLog('info', `Excluded ${before - driveFiles.length} GDrive midterm/final file(s)`);
              }
              addLog('info', `GDrive: ${driveFiles.length} files for "${courseCode}"`);

              const totalCount = dbFiles.length + driveFiles.length;
              if (totalCount > 0) {
                const contextLabel = contextTerms.length > 0 ? `(${contextTerms.join(', ')})` : '';
                const excludeLabel = excludeTerms.length > 0 ? ` [excluding: ${excludeTerms.join(', ')}]` : '';
                await sendAndLogTextMessage(sender, `Found ${totalCount} file(s) matching "${courseCode}" ${contextLabel}${excludeLabel}:`);

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
                return;
              }

              addLog('warn', `No files found for "${courseCode}" [${contextTerms}]. Falling through to AI.`);
            } catch (err: any) {
              addLog('error', `Search error: ${err.message}`);
            }
          }

          // Short direct input check (filename, file ID)
          const wordCount = text.split(/\s+/).length;
          if (wordCount <= 4 && !isConversationalQuery(text)) {
            const dbFile = await getFileByIdOrNameOrMessageId(text);
            if (dbFile) {
              try {
                await sendAndLogTextMessage(sender, `Found file: ${dbFile.filename}`);
                await sendFileToUser(sender, dbFile);
                return;
              } catch (err: any) {
                addLog('error', `Direct file send error: ${err.message}`);
              }
            }

            const driveFiles = await searchGDriveFiles(text);
            if (driveFiles.length > 0) {
              try {
                await sendAndLogTextMessage(sender, `Found: ${driveFiles[0].name}`);
                await sendGDriveFileToUser(sender, driveFiles[0]);
                return;
              } catch (err: any) {
                addLog('error', `Direct GDrive send error: ${err.message}`);
              }
            }
          }
        }

        // AI fallback
        let intent;
        try {
          intent = await processUserIntent(text, isSenderAdmin);
          addLog('info', `AI intent: ${intent.type}`);
        } catch (aiErr: any) {
          addLog('error', `AI error: ${aiErr.message}`);
          intent = { type: 'chat', reply: "I'm here to help! Send a course code like 'cs405 final' to get files." };
        }

        switch (intent.type) {
          case 'add_admin':
            if (isSenderAdmin && intent.newNumber) {
              const success = await addAdmin(intent.newNumber, sender);
              await sendAndLogTextMessage(sender, success ? `Added ${intent.newNumber} as admin.` : "Failed to add admin.");
            } else {
              await sendAndLogTextMessage(sender, "Only admins can add new admins.");
            }
            break;
          case 'send_file':
            if (intent.filename) {
              const { contextTerms } = extractSmartSearchParams(text);
              const dbFile = await getFileByIdOrNameOrMessageId(intent.filename);
              if (dbFile) {
                await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                await sendFileToUser(sender, dbFile);
              } else {
                const driveFiles = await searchGDriveFiles(intent.filename, contextTerms);
                if (driveFiles.length > 0) {
                  await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                  await sendGDriveFileToUser(sender, driveFiles[0]);
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
