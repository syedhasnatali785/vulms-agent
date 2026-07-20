import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage, saveLog } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage, sendInteractiveButtons } from '@/lib/whatsapp';
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

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// In-memory deduplication cache
const processedMessageIds = new Set<string>();
const MAX_CACHE_SIZE = 1000;

// Track the latest message ID processed for each user to cancel ongoing batch sends if they respond
const userLastMessageId = new Map<string, string>();

interface QueueItem {
  courseCode: string;
  contextTerms: string[];
  excludeTerms: string[];
  totalCount: number;
  dbFiles: any[];
  driveFiles: any[];
}

// In-memory queue storage mapping user phone number to their list of pending course files to confirm/send
const userQueues = new Map<string, QueueItem[]>();

function extractDistinctCourseCodes(text: string): string[] {
  const coursePattern = /\b([a-zA-Z]{2,5})\s*[-_]?\s*(\d{2,4})\b/gi;
  const codes = new Set<string>();
  let match;
  while ((match = coursePattern.exec(text)) !== null) {
    codes.add(`${match[1].toLowerCase()}${match[2]}`);
  }
  return Array.from(codes);
}

async function askUserForFirstQueueItem(sender: string) {
  const queue = userQueues.get(sender);
  if (!queue || queue.length === 0) {
    userQueues.delete(sender);
    return;
  }
  
  const currentItem = queue[0];
  const courseUpper = currentItem.courseCode.toUpperCase();
  const msg = `I found ${currentItem.totalCount} files for this course ${courseUpper}.\n\nWould you like me to send all files for this ${courseUpper} course?`;
  
  try {
    await sendInteractiveButtons(sender, msg, [
      { id: `queue_yes_${currentItem.courseCode}`, title: 'Yes' },
      { id: `queue_no_${currentItem.courseCode}`, title: 'No' }
    ]);
    addLog('info', `→ Sent button invitation to ${sender} for ${courseUpper}`);
  } catch (err: any) {
    addLog('error', `Failed sending interactive button message to ${sender}: ${err.message}`);
    // Fallback: send text message
    await sendAndLogTextMessage(sender, `${msg}\n\n(Reply with Yes or No to confirm)`);
  }
}

async function handleQueueInteraction(sender: string, courseCode: string, isYes: boolean, isSenderAdmin: boolean, messageId?: string) {
  const queue = userQueues.get(sender);
  if (!queue || queue.length === 0) {
    addLog('warn', `Interaction received for user ${sender} but queue is empty.`);
    userQueues.delete(sender);
    return;
  }
  
  const currentItem = queue[0];
  if (currentItem.courseCode !== courseCode) {
    addLog('warn', `Queue mismatch for user ${sender}: expected ${currentItem.courseCode}, got ${courseCode}`);
    return;
  }
  
  // Remove the current item from the queue
  queue.shift();
  userQueues.set(sender, queue);
  
  const courseUpper = courseCode.toUpperCase();
  
  if (isYes) {
    await sendAndLogTextMessage(sender, `Starting to send files for ${courseUpper}...`);
    
    // Set userLastMessageId so any new text messages can cancel this send operation
    if (messageId) {
      userLastMessageId.set(sender, messageId);
    }
    
    const allFiles = [
      ...currentItem.dbFiles.map(f => ({ source: 'db' as const, file: f })),
      ...currentItem.driveFiles.map(f => ({ source: 'gdrive' as const, file: f })),
    ];
    
    // Process sending files in the background using chunked parallel batches of 5
    (async () => {
      try {
        for (const batch of chunk(allFiles, 5)) {
          // Check if aborted
          if (messageId && userLastMessageId.get(sender) !== messageId) {
            addLog('warn', `Aborted file sending for ${sender} because they sent a new message.`);
            return;
          }
          await Promise.all(
            batch.map(async ({ source, file }) => {
              try {
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
        
        // Check if there is still a queue and if it's the active session
        const updatedQueue = userQueues.get(sender);
        if (updatedQueue && updatedQueue.length > 0) {
          // Wait 2.5 seconds before prompting the next item so messages don't overlap too fast
          setTimeout(async () => {
            await askUserForFirstQueueItem(sender);
          }, 2500);
        } else {
          userQueues.delete(sender);
          await sendAndLogTextMessage(sender, `All files for ${courseUpper} sent successfully!`);
        }
      } catch (err: any) {
        addLog('error', `Error in background file sending for ${courseUpper}: ${err.message}`);
      }
    })();
  } else {
    addLog('info', `User ${sender} skipped sending files for ${courseUpper}.`);
    
    if (queue.length > 0) {
      await askUserForFirstQueueItem(sender);
    } else {
      userQueues.delete(sender);
      await sendAndLogTextMessage(sender, `Skipped sending files for ${courseUpper}. No more pending courses in queue.`);
    }
  }
}

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

      // 0. Handle Interactive Button Replies
      if (message.type === 'interactive') {
        const interactiveType = message.interactive?.type;
        if (interactiveType === 'button_reply') {
          const buttonId = message.interactive.button_reply?.id || '';
          const buttonTitle = message.interactive.button_reply?.title || '';
          await saveMessage(sender, `[Button Clicked]: ${buttonTitle} (${buttonId})`, 'incoming');
          addLog('info', `← ${sender} clicked button: ${buttonTitle} (${buttonId})`);

          if (buttonId.startsWith('queue_yes_') || buttonId.startsWith('queue_no_')) {
            const isYes = buttonId.startsWith('queue_yes_');
            const courseCode = buttonId.replace(isYes ? 'queue_yes_' : 'queue_no_', '');
            await handleQueueInteraction(sender, courseCode, isYes, isSenderAdmin, messageId);
            return;
          }
        }
      }

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

        // Check if there is an active queue for this user, and they replied with a confirmation text
        const cleanText = text.toLowerCase().trim();
        if (userQueues.has(sender) && (cleanText === 'yes' || cleanText === 'no' || cleanText === 'y' || cleanText === 'n')) {
          const queue = userQueues.get(sender);
          if (queue && queue.length > 0) {
            const currentItem = queue[0];
            const isYes = cleanText === 'yes' || cleanText === 'y';
            await handleQueueInteraction(sender, currentItem.courseCode, isYes, isSenderAdmin, messageId);
            return;
          }
        }

        // Skip greetings
        if (isConversationalQuery(text)) {
          addLog('info', `Greeting detected, skipping file search for "${text}"`);
          // Fall through to AI
        } else {
          // Extract all distinct course codes
          const distinctCourses = extractDistinctCourseCodes(text);

          if (distinctCourses.length > 0) {
            addLog('info', `Extracted courses from text: [${distinctCourses.join(', ')}]`);
            const { contextTerms, excludeTerms } = extractSmartSearchParams(text);

            const queueItems: QueueItem[] = [];

            for (const courseCode of distinctCourses) {
              try {
                // Search Supabase
                let dbFiles = await getFilesByKeywords([courseCode], contextTerms);
                if (!isSenderAdmin) {
                  dbFiles = dbFiles.filter(f => !isMidtermFile(f.filename) && isFinalTermFile(f.filename));
                } else {
                  dbFiles = dbFiles.filter(f => !f.filename.toLowerCase().includes('midterm'));
                  if (excludeTerms.length > 0) {
                    dbFiles = dbFiles.filter(f => !excludeTerms.some(ex => f.filename.toLowerCase().includes(ex)));
                  }
                }

                // Search Google Drive
                let driveFiles = await searchGDriveFiles(courseCode, contextTerms);
                if (!isSenderAdmin) {
                  driveFiles = driveFiles.filter(f => !isMidtermFile(f.name) && isFinalTermFile(f.name));
                } else {
                  driveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
                  if (excludeTerms.length > 0) {
                    driveFiles = driveFiles.filter(f => !excludeTerms.some(ex => f.name.toLowerCase().includes(ex)));
                  }
                }

                const totalCount = dbFiles.length + driveFiles.length;
                if (totalCount > 0) {
                  queueItems.push({
                    courseCode,
                    contextTerms,
                    excludeTerms,
                    totalCount,
                    dbFiles,
                    driveFiles
                  });
                }
              } catch (err: any) {
                addLog('error', `Search setup error for "${courseCode}": ${err.message}`);
              }
            }

            if (queueItems.length > 0) {
              // Reset/Over-write the queue for this user
              userQueues.set(sender, queueItems);
              // Ask user for the first course
              await askUserForFirstQueueItem(sender);
              return;
            }

            addLog('warn', `No files found for extracted courses: [${distinctCourses.join(', ')}]. Falling through to AI.`);
          }
        }

        // Short direct input check (filename, file ID)
        const wordCount = text.split(/\s+/).length;
        if (wordCount <= 4 && !isConversationalQuery(text)) {
          const dbFile = await getFileByIdOrNameOrMessageId(text);
          if (dbFile) {
            const allowed = isSenderAdmin || (!isMidtermFile(dbFile.filename) && isFinalTermFile(dbFile.filename));
            if (allowed) {
              try {
                await sendAndLogTextMessage(sender, `Found file: ${dbFile.filename}`);
                await sendFileToUser(sender, dbFile, isSenderAdmin);
                return;
              } catch (err: any) {
                addLog('error', `Direct file send error: ${err.message}`);
              }
            }
          }

          const driveFiles = await searchGDriveFiles(text);
          let filteredDriveFiles = driveFiles;
          if (!isSenderAdmin) {
            filteredDriveFiles = driveFiles.filter(f => !isMidtermFile(f.name) && isFinalTermFile(f.name));
          } else {
            filteredDriveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
          }
          if (filteredDriveFiles.length > 0) {
            try {
              await sendAndLogTextMessage(sender, `Found: ${filteredDriveFiles[0].name}`);
              await sendGDriveFileToUser(sender, filteredDriveFiles[0], isSenderAdmin);
              return;
            } catch (err: any) {
              addLog('error', `Direct GDrive send error: ${err.message}`);
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
          intent = { type: 'chat', reply: "👋Welcome Im  SYED 1.2 , an AI language model built by  Syed Hasnat Ali  📚 Simply send me a  course code  (for example:  CS101 ,  MTH101 , or  ENG201*), and I'll process your request and do my best to provide the relevant files and study materials. Just send your course code to get started!" };
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
              if (dbFile && (isSenderAdmin || (!isMidtermFile(dbFile.filename) && isFinalTermFile(dbFile.filename)))) {
                await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                await sendFileToUser(sender, dbFile, isSenderAdmin);
              } else {
                const driveFiles = await searchGDriveFiles(intent.filename, contextTerms);
                let filteredDriveFiles = driveFiles;
                if (!isSenderAdmin) {
                  filteredDriveFiles = driveFiles.filter(f => !isMidtermFile(f.name) && isFinalTermFile(f.name));
                } else {
                  filteredDriveFiles = driveFiles.filter(f => !f.name.toLowerCase().includes('midterm'));
                }
                if (filteredDriveFiles.length > 0) {
                  await sendAndLogTextMessage(sender, intent.reply || "Here is your file.");
                  await sendGDriveFileToUser(sender, filteredDriveFiles[0], isSenderAdmin);
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
