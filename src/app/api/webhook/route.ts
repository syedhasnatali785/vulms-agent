import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage, saveLog, hasUserSentNewMessage, getMessagesBySender } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage } from '@/lib/whatsapp';
import { uploadFileToR2, getFileUrl } from '@/lib/r2';
import { processUserIntent } from '@/lib/ai';
import { searchGDriveFiles } from '@/lib/gdrive';
import { isMidtermFile, isFinalTermFile } from '@/lib/fileFilters';

export const maxDuration = 10;
export const dynamic = 'force-dynamic';

/** Split an array into chunks of a given size for batched parallel processing */
function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );
}

/**
 * Extract VU-style course codes from a freeform string.
 * Matches patterns like CS302, MTH101, EDU 303, ENG201, etc.
 */
function extractCourseCodes(text: string): string[] {
  const matches = text.match(/\b([A-Z]{2,4})\s*(\d{3,4}[A-Z]?)\b/gi) || [];
  // Normalise to uppercase without spaces and deduplicate
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const m of matches) {
    const normalised = m.replace(/\s+/g, '').toUpperCase();
    if (!seen.has(normalised)) { seen.add(normalised); codes.push(normalised); }
  }
  return codes;
}

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// In-memory deduplication cache
const processedMessageIds = new Set<string>();
const MAX_CACHE_SIZE = 1000;

// Track the latest message ID processed for each user to cancel ongoing batch sends if they respond
const userLastMessageId = new Map<string, string>();

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

async function sendFileToUser(sender: string, file: any, isSenderAdmin: boolean) {
  if (!isSenderAdmin) {
    if (isMidtermFile(file.filename) || !isFinalTermFile(file.filename)) {
      addLog('warn', `Blocked sending file "${file.filename}" because it is not a final term file`);
      return;
    }
  }
  const fileUrl = await getFileUrl(file.r2_key);
  const mediaType = file.mime_type.startsWith('image') ? 'image'
    : file.mime_type.startsWith('video') ? 'video'
      : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.filename, '(By SYED BOT)');
  addLog('info', `→ Sent file "${file.filename}" to ${sender}`);
}

async function sendGDriveFileToUser(sender: string, file: any, isSenderAdmin: boolean) {
  if (!isSenderAdmin) {
    if (isMidtermFile(file.name) || !isFinalTermFile(file.name)) {
      addLog('warn', `Blocked sending GDrive file "${file.name}" because it is not a final term file`);
      return;
    }
  }
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${process.env.GOOGLE_API_KEY}`;
  const mediaType = file.mimeType.startsWith('image') ? 'image'
    : file.mimeType.startsWith('video') ? 'video'
      : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.name, '(By SYED BOT)');
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
      if (messageId && sender) {
        userLastMessageId.set(sender, messageId);
      }
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
        const savedMsg = await saveMessage(sender, text, 'incoming');
        const triggerMessageDbId = savedMsg?.id;
        const triggerMessageCreatedAt = savedMsg?.created_at;
        addLog('info', `← ${sender}: "${text}" (Db ID: ${triggerMessageDbId}, created_at: ${triggerMessageCreatedAt})`);

        // AI processing handles all messages now
        let intent;
        try {
          const history = await getMessagesBySender(sender, 10);
          intent = await processUserIntent(text, isSenderAdmin, history);
          addLog('info', `AI intent: ${intent.type}`);
        } catch (aiErr: any) {
          addLog('error', `AI error: ${aiErr.message}`);
          // Smart fallback: if AI times out or fails, extract course codes from the
          // user's message via regex and proceed to search directly.
          const fallbackCodes = extractCourseCodes(text);
          if (fallbackCodes.length > 1) {
            intent = {
              type: 'send_files',
              searches: fallbackCodes.map(code => ({ search_query: code, quantity: 10, context_terms: [], exclude_terms: [] })),
              reply: `${fallbackCodes.length} courses ki files search ho rahi hain: ${fallbackCodes.join(', ')}. Please wait...`
            };
          } else if (fallbackCodes.length === 1) {
            intent = {
              type: 'send_file',
              search_query: fallbackCodes[0],
              quantity: 10,
              context_terms: [],
              exclude_terms: [],
              reply: `${fallbackCodes[0]} ki files search ho rahi hain. Please wait...`
            };
          } else {
            intent = { type: 'chat', reply: 'Mujhe samajh nahi aaya. Please course code likhein (jaise CS302, MTH101).' };
          }
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
            const searchQuery = intent.search_query || intent.filename || text;
            const limitQuantity = Math.min(10, Math.max(1, parseInt(intent.quantity, 10) || 10));
            const contextTerms: string[] = intent.context_terms || [];
            const excludeTerms: string[] = intent.exclude_terms || [];

            addLog('info', `AI requesting files: query="${searchQuery}", qty=${limitQuantity}, context=[${contextTerms}], exclude=[${excludeTerms}]`);

            let dbFiles: any[] = [];
            // 1. Try to fetch direct file by ID or specific filename/message ID first
            const directDbFile = await getFileByIdOrNameOrMessageId(searchQuery);
            if (directDbFile) {
              const allowed = isSenderAdmin || (!isMidtermFile(directDbFile.filename) && isFinalTermFile(directDbFile.filename));
              if (allowed) {
                dbFiles.push(directDbFile);
              }
            }

            // 2. Search database by keywords/course code if not found or if we want more files
            if (dbFiles.length < limitQuantity) {
              let keywordDbFiles = await getFilesByKeywords([searchQuery], contextTerms);
              // Filter out duplicate files and filter by midterm/final role restriction
              for (const f of keywordDbFiles) {
                if (dbFiles.some(existing => existing.id === f.id)) continue;
                const allowed = isSenderAdmin || (!isMidtermFile(f.filename) && isFinalTermFile(f.filename));
                if (!allowed) continue;

                // Apply exclusion filter
                const nameLower = f.filename.toLowerCase();
                if (excludeTerms.some((ex: string) => nameLower.includes(ex.toLowerCase()))) continue;

                dbFiles.push(f);
              }
            }

            // 3. Search Google Drive
            let driveFiles: any[] = [];
            try {
              const rawDriveFiles = await searchGDriveFiles(searchQuery, contextTerms);
              for (const f of rawDriveFiles) {
                const allowed = isSenderAdmin || (!isMidtermFile(f.name) && isFinalTermFile(f.name));
                if (!allowed) continue;

                // Apply exclusion filter
                const nameLower = f.name.toLowerCase();
                if (excludeTerms.some((ex: string) => nameLower.includes(ex.toLowerCase()))) continue;

                driveFiles.push(f);
              }
            } catch (err: any) {
              addLog('error', `GDrive search error: ${err.message}`);
            }

            // Merge and deduplicate DB & Drive files by name
            const allFiles: { source: 'db' | 'gdrive'; file: any; name: string }[] = [];
            const seenNames = new Set<string>();

            for (const f of dbFiles) {
              const nameLower = f.filename.toLowerCase();
              if (!seenNames.has(nameLower)) {
                seenNames.add(nameLower);
                allFiles.push({ source: 'db', file: f, name: f.filename });
              }
            }

            for (const f of driveFiles) {
              const nameLower = f.name.toLowerCase();
              if (!seenNames.has(nameLower)) {
                seenNames.add(nameLower);
                allFiles.push({ source: 'gdrive', file: f, name: f.name });
              }
            }

            // Slice to the requested quantity limit
            const finalFiles = allFiles.slice(0, limitQuantity);

            if (finalFiles.length > 0) {
              // Send the AI's reply message first
              await sendAndLogTextMessage(sender, intent.reply || `Found ${finalFiles.length} file(s) matching "${searchQuery}":`);

              // Send in parallel batches of 5
              for (const batch of chunk(finalFiles, 5)) {
                // Database-backed cancellation check
                if (triggerMessageDbId) {
                  const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                  if (hasNew) {
                    addLog('warn', `Aborted file sending for ${sender} because they sent a new message (DB check).`);
                    return;
                  }
                }

                // In-memory cancellation check
                if (messageId && userLastMessageId.get(sender) !== messageId) {
                  addLog('warn', `Aborted file sending for ${sender} because they sent a new message (in-memory check).`);
                  return;
                }

                await Promise.all(
                  batch.map(async ({ source, file }) => {
                    try {
                      // Double check cancellation before sending each individual file
                      if (triggerMessageDbId) {
                        const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                        if (hasNew) return;
                      }
                      if (messageId && userLastMessageId.get(sender) !== messageId) {
                        return;
                      }

                      if (source === 'db') {
                        await sendFileToUser(sender, file, isSenderAdmin);
                      } else {
                        await sendGDriveFileToUser(sender, file, isSenderAdmin);
                      }
                    } catch (err: any) {
                      addLog('error', `Failed sending ${source} file: ${err.message}`);
                    }
                  })
                );
              }
            } else {
              await sendAndLogTextMessage(sender, intent.reply || `Sorry, no files found for "${searchQuery}".`);
            }
            break;

          case 'send_files': {
            // Multiple courses — run all searches in parallel then send results sequentially
            const multiSearches: Array<{ search_query: string; quantity: number; context_terms: string[]; exclude_terms: string[] }> =
              intent.searches || [];

            if (multiSearches.length === 0) break;

            await sendAndLogTextMessage(sender, intent.reply || `${multiSearches.length} courses ki files search ho rahi hain. Please wait...`);

            // Run all Google Drive + DB searches in parallel
            const searchResults = await Promise.all(
              multiSearches.map(async (s) => {
                const sq = s.search_query;
                const qty = Math.min(10, Math.max(1, s.quantity || 10));
                const ctx: string[] = s.context_terms || [];
                const excl: string[] = s.exclude_terms || [];

                let dbFiles: any[] = [];
                const directDbFile = await getFileByIdOrNameOrMessageId(sq);
                if (directDbFile) {
                  const allowed = isSenderAdmin || (!isMidtermFile(directDbFile.filename) && isFinalTermFile(directDbFile.filename));
                  if (allowed) dbFiles.push(directDbFile);
                }
                if (dbFiles.length < qty) {
                  const kw = await getFilesByKeywords([sq], ctx);
                  for (const f of kw) {
                    if (dbFiles.some((e: any) => e.id === f.id)) continue;
                    const allowed = isSenderAdmin || (!isMidtermFile(f.filename) && isFinalTermFile(f.filename));
                    if (!allowed) continue;
                    const nl = f.filename.toLowerCase();
                    if (excl.some((ex: string) => nl.includes(ex.toLowerCase()))) continue;
                    dbFiles.push(f);
                  }
                }

                let driveFiles: any[] = [];
                try {
                  const raw = await searchGDriveFiles(sq, ctx);
                  for (const f of raw) {
                    const allowed = isSenderAdmin || (!isMidtermFile(f.name) && isFinalTermFile(f.name));
                    if (!allowed) continue;
                    const nl = f.name.toLowerCase();
                    if (excl.some((ex: string) => nl.includes(ex.toLowerCase()))) continue;
                    driveFiles.push(f);
                  }
                } catch (err: any) {
                  addLog('error', `GDrive search error for "${sq}": ${err.message}`);
                }

                const seen = new Set<string>();
                const merged: { source: 'db' | 'gdrive'; file: any; name: string }[] = [];
                for (const f of dbFiles) {
                  const nl = f.filename.toLowerCase();
                  if (!seen.has(nl)) { seen.add(nl); merged.push({ source: 'db', file: f, name: f.filename }); }
                }
                for (const f of driveFiles) {
                  const nl = f.name.toLowerCase();
                  if (!seen.has(nl)) { seen.add(nl); merged.push({ source: 'gdrive', file: f, name: f.name }); }
                }

                return { query: sq, files: merged.slice(0, qty) };
              })
            );

            // Send results course-by-course
            for (const { query, files } of searchResults) {
              // Cancellation check between courses
              if (triggerMessageDbId) {
                const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                if (hasNew) { addLog('warn', `Aborted multi-send for ${sender} — new message detected.`); return; }
              }
              if (messageId && userLastMessageId.get(sender) !== messageId) return;

              if (files.length === 0) {
                await sendAndLogTextMessage(sender, `❌ "${query}" ke liye koi file nahi mili.`);
                continue;
              }

              await sendAndLogTextMessage(sender, `📂 *${query.toUpperCase()}* — ${files.length} file(s):`);

              for (const batch of chunk(files, 5)) {
                if (triggerMessageDbId) {
                  const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                  if (hasNew) return;
                }
                if (messageId && userLastMessageId.get(sender) !== messageId) return;

                await Promise.all(
                  batch.map(async ({ source, file }) => {
                    try {
                      if (triggerMessageDbId) {
                        const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                        if (hasNew) return;
                      }
                      if (messageId && userLastMessageId.get(sender) !== messageId) return;
                      if (source === 'db') {
                        await sendFileToUser(sender, file, isSenderAdmin);
                      } else {
                        await sendGDriveFileToUser(sender, file, isSenderAdmin);
                      }
                    } catch (err: any) {
                      addLog('error', `Failed sending ${source} file for "${query}": ${err.message}`);
                    }
                  })
                );
              }
            }
            break;
          }

          case 'chat':
          default:
            await sendAndLogTextMessage(sender, intent.reply || "Mujhe samajh nahi aaya. Course code likhein (jaise CS302).");
            break;
        }
      }
    });

    // Fire-and-forget: return 200 immediately so WhatsApp doesn't retry,
    // then continue processing in the background (safe on a persistent VPS).
    Promise.all(processPromises).catch((err) => {
      addLog('error', `Background processing error: ${err.message}`);
      console.error('Background processing error:', err);
    });
    return new NextResponse('OK', { status: 200 });
  } catch (error: any) {
    addLog('error', `Webhook crash: ${error.message}`);
    console.error('Webhook Error:', error);
    return new NextResponse('OK', { status: 200 });
  }
}
