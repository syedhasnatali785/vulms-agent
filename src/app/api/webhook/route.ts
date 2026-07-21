import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage, saveLog, hasUserSentNewMessage, getMessagesBySender } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage } from '@/lib/whatsapp';
import { uploadFileToR2, getFileUrl, downloadFileContentFromR2 } from '@/lib/r2';
import { processUserIntent, classifyAdminReview } from '@/lib/ai';
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
  // Plain-text reviews are stored as text/plain — send content as a WhatsApp text
  // message instead of a document attachment so students receive readable text.
  if (file.mime_type && file.mime_type.startsWith('text/plain')) {
    try {
      const content = await downloadFileContentFromR2(file.r2_key);
      const header = `📋 *Current Paper Review — ${file.filename.replace(/_/g, ' ').replace(/\.txt$/i, '')}*\n\n`;
      // WhatsApp has a ~4096 char limit per message; chunk if needed
      const fullText = header + content;
      const MAX_CHUNK = 3800;
      if (fullText.length <= MAX_CHUNK) {
        await sendTextMessage(sender, fullText);
      } else {
        for (let i = 0; i < fullText.length; i += MAX_CHUNK) {
          await sendTextMessage(sender, fullText.slice(i, i + MAX_CHUNK));
        }
      }
      addLog('info', `→ Sent review text "${file.filename}" to ${sender}`);
      return;
    } catch (err: any) {
      addLog('error', `Failed to read review content for "${file.filename}": ${err.message}`);
      // Fall through to send as document if download fails
    }
  }

  // DB files are uploaded by admins, so standard users should be allowed to receive them on demand.
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

      // 1. Handle Media Input
      if (MEDIA_TYPES.includes(message.type)) {
        const mediaObj = message[message.type];
        const caption = mediaObj?.caption || '';
        const rawFilename = (message.type === 'document' && message.document?.filename)
          ? message.document.filename
          : (mediaObj?.filename || '');

        if (isSenderAdmin) {
          addLog('info', `Media received from admin ${sender}. Saving to Private Database...`);
          try {
            const mediaId = mediaObj?.id;
            if (!mediaId) {
              throw new Error('No media ID found in message payload.');
            }
            await sendAndLogTextMessage(sender, "📥 Processing and uploading your file. Please wait...");

            const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);

            let filename = rawFilename || caption;
            if (!filename) {
              const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
              filename = `${mediaId}.${ext}`;
            } else {
              filename = filename.trim();
              const expectedExt = mimeType.split('/')[1]?.split(';')[0] || '';
              if (expectedExt && !filename.toLowerCase().endsWith(`.${expectedExt.toLowerCase()}`)) {
                const hasExtension = /\.[a-zA-Z0-9]{2,4}$/.test(filename);
                if (!hasExtension) {
                  filename = `${filename}.${expectedExt}`;
                }
              }
            }

            // Sanitize filename from directory traversal slashes
            const sanitizedFilename = filename.replace(/[\/\\]/g, '_');
            const r2Key = `uploads/${messageId || Date.now()}_${sanitizedFilename}`;
            await uploadFileToR2(r2Key, buffer, mimeType);
            const fileRecord = await saveFileMetadata(sanitizedFilename, r2Key, mimeType, sender, messageId);

            if (fileRecord) {
              await sendAndLogTextMessage(sender, `✅ File "${sanitizedFilename}" saved successfully to and database (ID: ${fileRecord.id}).`);
            } else {
              await sendAndLogTextMessage(sender, `⚠️ File "${sanitizedFilename}" uploaded to Database, but failed to save metadata in the database.`);
            }
          } catch (err: any) {
            addLog('error', `Failed to process admin file upload: ${err.message}`);
            await sendAndLogTextMessage(sender, `❌ Error processing file upload: ${err.message}`);
          }
          return;
        } else {
          // Standard user sending file -> only read their name/caption and search
          let mediaTitle = rawFilename || caption;
          if (rawFilename && caption && rawFilename !== caption) {
            mediaTitle = `${rawFilename} ${caption}`;
          }
          mediaTitle = mediaTitle.trim();

          if (mediaTitle) {
            addLog('info', `Media received from standard user ${sender}. Reading title/caption: "${mediaTitle}"`);
            message.type = 'text';
            message.text = { body: mediaTitle };
          } else {
            addLog('info', `Media received from standard user ${sender} without title/caption.`);
            await sendAndLogTextMessage(sender, "Please send a file with a name/caption, or send a text message with your course code (e.g. CS302) to search for files.");
            return;
          }
        }
      }

      // 2. Handle Text Messages
      if (message.type === 'text') {
        const text = message.text.body.trim();
        const savedMsg = await saveMessage(sender, text, 'incoming');
        const triggerMessageDbId = savedMsg?.id;
        const triggerMessageCreatedAt = savedMsg?.created_at;
        addLog('info', `← ${sender}: "${text}" (Db ID: ${triggerMessageDbId}, created_at: ${triggerMessageCreatedAt})`);

        // Check if admin is sending a Current Paper Review to save (AI-verified)
        if (isSenderAdmin && text.length > 30) {
          const lowerText = text.toLowerCase();
          // Quick pre-filter: only bother calling AI if the text looks vaguely review-like
          const mightBeReview = /review|current\s*paper|today.*paper|mcq|subjective|questions|exam|aaya|aa gaya|aya/i.test(lowerText);
          if (mightBeReview) {
            addLog('info', `Possible review from admin ${sender}. Asking AI to classify...`);
            const classification = await classifyAdminReview(text);
            addLog('info', `AI review classification: is_review=${classification.is_review}, codes=${classification.course_codes.join(',')}, reason=${classification.reason}`);

            if (classification.is_review && classification.course_codes.length > 0) {
              try {
                await sendAndLogTextMessage(sender, `📥 AI confirmed this is a paper review for ${classification.course_codes.join(', ')}. Saving...`);
                const buffer = Buffer.from(text, 'utf-8');
                const mimeType = 'text/plain; charset=utf-8';
                for (const code of classification.course_codes) {
                  const ts = messageId || Date.now();
                  const filename = `${code}_Current_Paper_Review_${ts}.txt`;
                  const r2Key = `reviews/${code}_Current_Paper_Review_${ts}.txt`;
                  await uploadFileToR2(r2Key, buffer, mimeType);
                  await saveFileMetadata(filename, r2Key, mimeType, sender, messageId);
                }
                await sendAndLogTextMessage(sender, `✅ Paper review for ${classification.course_codes.join(', ')} saved to Cloudflare R2 and database.`);
              } catch (err: any) {
                addLog('error', `Failed to save admin review: ${err.message}`);
                await sendAndLogTextMessage(sender, `❌ Error saving your review: ${err.message}`);
              }
              return; // Stop — do not process as a file/chat request
            }
            // AI said it is NOT a review — fall through to normal intent processing
          }
        }

        // AI processing handles messages, unless @all bypass is requested
        let intent;
        if (text.toLowerCase().includes('@all')) {
          addLog('info', `@all keyword detected in message: "${text}" - bypassing AI for direct search`);
          const queryClean = text.replace(/@all/gi, '').trim();
          const codes = extractCourseCodes(queryClean);

          if (codes.length > 1) {
            intent = {
              type: 'send_files',
              searches: codes.map(code => ({ search_query: code, quantity: 999, context_terms: [], exclude_terms: [] })),
              reply: `🔍 Direct search (@all): ${codes.length} courses ki tamam files search ho rahi hain (${codes.join(', ')})...`
            };
          } else if (codes.length === 1) {
            intent = {
              type: 'send_file',
              search_query: codes[0],
              quantity: 999,
              context_terms: [],
              exclude_terms: [],
              reply: `🔍 Direct search (@all): ${codes[0]} ki tamam files search ho rahi hain...`
            };
          } else if (queryClean.length > 0) {
            intent = {
              type: 'send_file',
              search_query: queryClean,
              quantity: 999,
              context_terms: [],
              exclude_terms: [],
              reply: `🔍 Direct search (@all): "${queryClean}" ki tamam files search ho rahi hain...`
            };
          } else {
            intent = {
              type: 'chat',
              reply: 'Please @all ke saath subject code likhein (e.g. @all CS302).'
            };
          }
        } else {
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
                searches: fallbackCodes.map(code => ({ search_query: code, quantity: 5, context_terms: [], exclude_terms: [] })),
                reply: `${fallbackCodes.length} courses ki files search ho rahi hain: ${fallbackCodes.join(', ')}. Please wait...`
              };
            } else if (fallbackCodes.length === 1) {
              intent = {
                type: 'send_file',
                search_query: fallbackCodes[0],
                quantity: 5,
                context_terms: [],
                exclude_terms: [],
                reply: `${fallbackCodes[0]} ki files search ho rahi hain. Please wait...`
              };
            } else {
              intent = { type: 'chat', reply: 'Mujhe samajh nahi aaya. Please course code likhein (jaise CS302, MTH101).' };
            }
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
            const limitQuantity = Math.max(1, parseInt(intent.quantity, 10) || 5);
            const contextTerms: string[] = intent.context_terms || [];
            const excludeTerms: string[] = intent.exclude_terms || [];

            // Detect review/current in original message to prioritize/include reviews
            const originalLower = text.toLowerCase();
            if (originalLower.includes('review') && !contextTerms.includes('review')) {
              contextTerms.push('review');
            }
            if (originalLower.includes('current') && !contextTerms.includes('current')) {
              contextTerms.push('current');
            }

            addLog('info', `AI requesting files: query="${searchQuery}", qty=${limitQuantity}, context=[${contextTerms}], exclude=[${excludeTerms}]`);

            let dbFiles: any[] = [];
            // 1. Try to fetch direct file by ID or specific filename/message ID first
            const directDbFile = await getFileByIdOrNameOrMessageId(searchQuery);
            if (directDbFile) {
              // Standard users can receive DB/R2 files when requested
              dbFiles.push(directDbFile);
            }

            // 2. Search database by keywords/course code if not found or if we want more files
            if (dbFiles.length < limitQuantity) {
              let keywordDbFiles = await getFilesByKeywords([searchQuery], contextTerms);
              // Filter out duplicate files
              for (const f of keywordDbFiles) {
                if (dbFiles.some(existing => existing.id === f.id)) continue;

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
              addLog('error', `DB search error: ${err.message}`);
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
                const qty = Math.max(1, s.quantity || 5);
                const ctx: string[] = s.context_terms || [];
                const excl: string[] = s.exclude_terms || [];

                // Detect review/current in original message to prioritize/include reviews
                const originalLower = text.toLowerCase();
                if (originalLower.includes('review') && !ctx.includes('review')) {
                  ctx.push('review');
                }
                if (originalLower.includes('current') && !ctx.includes('current')) {
                  ctx.push('current');
                }

                let dbFiles: any[] = [];
                const directDbFile = await getFileByIdOrNameOrMessageId(sq);
                if (directDbFile) {
                  dbFiles.push(directDbFile);
                }
                if (dbFiles.length < qty) {
                  const kw = await getFilesByKeywords([sq], ctx);
                  for (const f of kw) {
                    if (dbFiles.some((e: any) => e.id === f.id)) continue;
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

          case 'keyword_search': {
            // Broad keyword search — returns ALL matching files from DB (no Drive, no qty cap)
            const rawKeywords: string[] = intent.keywords || [];
            if (rawKeywords.length === 0) break;

            // Expand each raw keyword into all format variants (eng201, ENG201, eng_201, …)
            const { extractCourseKeywords: extractKW } = await import('@/lib/supabase');
            const expandedKeywords: string[] = [];
            const seenKW = new Set<string>();
            for (const kw of rawKeywords) {
              for (const variant of extractKW(kw)) {
                if (!seenKW.has(variant)) { seenKW.add(variant); expandedKeywords.push(variant); }
              }
            }
            // Fallback: if expansion produced nothing (e.g. plain word), use raw keywords
            const finalKeywords = expandedKeywords.length > 0 ? expandedKeywords : rawKeywords;

            await sendAndLogTextMessage(sender, intent.reply || `Keyword search chal rahi hai: ${rawKeywords.join(', ')}. Please wait...`);
            addLog('info', `Keyword search: [${finalKeywords.join(', ')}]`);

            let kwFiles = await getFilesByKeywords(finalKeywords);

            if (kwFiles.length === 0) {
              await sendAndLogTextMessage(sender, `❌ Koi file nahi mili: "${rawKeywords.join(', ')}"`);
              break;
            }

            await sendAndLogTextMessage(sender, `✅ ${kwFiles.length} file(s) mili hain. Bhej raha hoon...`);

            for (const batch of chunk(kwFiles.map((f: any) => ({ source: 'db' as const, file: f, name: f.filename })), 5)) {
              if (triggerMessageDbId) {
                const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                if (hasNew) { addLog('warn', `Aborted keyword send for ${sender} — new message detected.`); return; }
              }
              if (messageId && userLastMessageId.get(sender) !== messageId) return;

              await Promise.all(
                batch.map(async ({ file }) => {
                  try {
                    if (triggerMessageDbId) {
                      const hasNew = await hasUserSentNewMessage(sender, triggerMessageDbId, triggerMessageCreatedAt);
                      if (hasNew) return;
                    }
                    if (messageId && userLastMessageId.get(sender) !== messageId) return;
                    await sendFileToUser(sender, file, isSenderAdmin);
                  } catch (err: any) {
                    addLog('error', `Failed sending keyword file: ${err.message}`);
                  }
                })
              );
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
