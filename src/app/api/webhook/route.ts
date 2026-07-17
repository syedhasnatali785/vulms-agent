import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractCourseKeywords, getFilesByKeywords, saveMessage } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage } from '@/lib/whatsapp';
import { uploadFileToR2, getFileUrl } from '@/lib/r2';
import { processUserIntent } from '@/lib/ai';
import { searchGDriveFiles } from '@/lib/gdrive';

// Vercel serverless function max duration (Hobby plan is restricted to 10s anyway, but this is good practice if upgraded)
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// In-memory cache for message deduplication (keeps last 1000 messages)
const processedMessageIds = new Set<string>();
const MAX_CACHE_SIZE = 1000;

function isDuplicateMessage(messageId: string): boolean {
  if (processedMessageIds.has(messageId)) {
    return true;
  }
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_CACHE_SIZE) {
    const oldestKey = processedMessageIds.values().next().value;
    if (oldestKey) processedMessageIds.delete(oldestKey);
  }
  return false;
}

// Set of conversational greeting words/short replies
const CONVERSATIONAL_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'hlo', 'hy', 'assalam', 'o', 'alaikum', 'aoa', 'ws', 'salam',
  'ok', 'okay', 'yes', 'no', 'yep', 'nope', 'g', 'ji', 'haan', 'fine',
  'thanks', 'thank', 'thankyou', 'welcome',
  'please', 'pls', 'help', 'info', 'test', 'status',
  'admin', 'agent', 'bot', 'good', 'morning', 'afternoon', 'evening'
]);

/**
 * Checks if the user text is a greeting or standard conversational word to prevent false-positive file delivery
 */
function isConversationalQuery(text: string): boolean {
  const clean = text.toLowerCase().trim().replace(/[?.!,]/g, '');
  if (!clean) return true;
  if (CONVERSATIONAL_WORDS.has(clean)) return true;
  
  const words = clean.split(/\s+/);
  return words.every(w => CONVERSATIONAL_WORDS.has(w));
}

/**
 * Filters a list of files based on keywords inside the user's message (e.g. handouts, highlighted, mids, finals)
 */
function filterFilesByContext(files: any[], text: string): any[] {
  const lowerText = text.toLowerCase();
  
  const wantsHighlighted = lowerText.includes('highlight');
  const wantsHandouts = lowerText.includes('handout');
  const wantsMids = /\b(mid|mids|midterm|mid-term)\b/i.test(lowerText);
  const wantsFinals = /\b(final|finals|finalterm|final-term)\b/i.test(lowerText);

  // If no specific category is mentioned in the query, return all matching files
  if (!wantsHighlighted && !wantsHandouts && !wantsMids && !wantsFinals) {
    return files;
  }
  
  let filtered = [...files];

  if (wantsHighlighted) {
    filtered = filtered.filter(f => {
      const name = (f.filename || f.name || '').toLowerCase();
      return name.includes('highlight');
    });
  }

  if (wantsHandouts) {
    filtered = filtered.filter(f => {
      const name = (f.filename || f.name || '').toLowerCase();
      return name.includes('handout');
    });
  }

  if (wantsMids) {
    filtered = filtered.filter(f => {
      const name = (f.filename || f.name || '').toLowerCase();
      return name.includes('mid') || name.includes('mids') || name.includes('midterm');
    });
  }

  if (wantsFinals) {
    filtered = filtered.filter(f => {
      const name = (f.filename || f.name || '').toLowerCase();
      return name.includes('final') || name.includes('finals') || name.includes('finalterm');
    });
  }

  return filtered;
}

/** Helper: sends a text message and logs it to Supabase */
async function sendAndLogTextMessage(to: string, text: string) {
  await sendTextMessage(to, text);
  await saveMessage(to, text, 'outgoing');
}

/** Helper: resolve a local file record to a media message sent to the user */
async function sendFileToUser(sender: string, file: any) {
  const fileUrl = await getFileUrl(file.r2_key);
  const mediaType = file.mime_type.startsWith('image') ? 'image'
                   : file.mime_type.startsWith('video') ? 'video'
                   : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.filename);
}

/** Helper: sends a Google Drive file directly as a media payload to WhatsApp without downloading it locally */
async function sendGDriveFileToUser(sender: string, file: any) {
  const fileUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&key=${process.env.GOOGLE_API_KEY}`;
  const mediaType = file.mimeType.startsWith('image') ? 'image'
                   : file.mimeType.startsWith('video') ? 'video'
                   : 'document' as const;
  await sendMediaMessage(sender, mediaType, fileUrl, file.name);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Check if it's a WhatsApp status update or actual message
    if (body.object !== 'whatsapp_business_account') {
      return new NextResponse('Not a WhatsApp event', { status: 404 });
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    
    // Acknowledge immediately to avoid Meta retries if no message
    if (!message) {
      return new NextResponse('OK', { status: 200 });
    }

    // Deduplication check
    const messageId = message.id;
    if (messageId && isDuplicateMessage(messageId)) {
      console.log(`Duplicate message ignored: ${messageId}`);
      return new NextResponse('OK', { status: 200 });
    }

    const sender = message.from;
    const isSenderAdmin = await isAdmin(sender);

    // 1. Handle File Uploads (Media)
    if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
      const mediaId = message[message.type].id;
      const caption = message[message.type].caption || '';
      
      try {
        await sendAndLogTextMessage(sender, "Downloading and saving your file...");
        const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
        
        // Generate a filename or use original filename/caption
        let rawFilename = '';
        if (message.type === 'document' && message.document?.filename) {
          rawFilename = message.document.filename;
        } else {
          rawFilename = caption || `file_${Date.now()}`;
        }
        
        const ext = mimeType.split('/')[1] || 'bin';
        const safeExt = ext.split(';')[0] || 'bin';
        
        // Ensure the filename has the correct extension if not already present
        let filename = rawFilename.replace(/\s+/g, '_');
        if (!filename.toLowerCase().endsWith(`.${safeExt.toLowerCase()}`)) {
          if (mimeType === 'application/pdf' && !filename.toLowerCase().endsWith('.pdf')) {
            filename = `${filename}.pdf`;
          } else {
            filename = `${filename}.${safeExt}`;
          }
        }
        
        // Store directly as uploads/filename in R2 so the key matches the filename
        const r2Key = `uploads/${filename}`;
        
        await uploadFileToR2(r2Key, buffer, mimeType);
        const savedFile = await saveFileMetadata(filename, r2Key, mimeType, sender);
        
        let successMessage = `File successfully saved!\n\n` +
          `📂 Filename: ${filename}\n`;
        
        if (savedFile) {
          successMessage += `🆔 File ID: ${savedFile.id}\n`;
        }
        successMessage += `✉️ Message ID: ${messageId}\n\n` +
          `You can retrieve this file anytime by typing its name or course code (e.g. "eng201").`;
        
        await sendAndLogTextMessage(sender, successMessage);
      } catch (e: any) {
        console.error("Upload Error:", e);
        await sendAndLogTextMessage(sender, "Failed to process the upload. Make sure the file is supported.");
      }
      return new NextResponse('OK', { status: 200 });
    }

    // 2. Handle Text Messages
    if (message.type === 'text') {
      const text = message.text.body.trim();

      // Log incoming text message to Supabase
      await saveMessage(sender, text, 'incoming');

      // ── Step 2a: Explicit "retrieve/get/download <query>" commands ──
      const retrieveMatch = text.match(/^(?:retrieve|get|download)\s+(.+)$/i);
      if (retrieveMatch) {
        const query = retrieveMatch[1].trim();
        
        // 1. Try Supabase first
        const dbFile = await getFileByIdOrNameOrMessageId(query);
        if (dbFile) {
          try {
            await sendAndLogTextMessage(sender, `Here is your file: ${dbFile.filename}`);
            await sendFileToUser(sender, dbFile);
          } catch (err) {
            console.error("Error sending retrieved file:", err);
            await sendAndLogTextMessage(sender, "Sorry, I found the file but failed to retrieve it from storage.");
          }
          return new NextResponse('OK', { status: 200 });
        }

        // 2. Try Google Drive (directly query and send download url)
        const driveFiles = await searchGDriveFiles(query);
        if (driveFiles.length > 0) {
          // If query has course parameters, apply filters
          const filteredDrive = filterFilesByContext(driveFiles, query);
          if (filteredDrive.length > 0) {
            const driveFile = filteredDrive[0];
            try {
              await sendAndLogTextMessage(sender, `Here is your file: ${driveFile.name}`);
              await sendGDriveFileToUser(sender, driveFile);
            } catch (err) {
              console.error("Error sending Google Drive file:", err);
              await sendAndLogTextMessage(sender, "Sorry, I found the file on Google Drive but failed to send it.");
            }
            return new NextResponse('OK', { status: 200 });
          }
        }

        await sendAndLogTextMessage(sender, `Sorry, I couldn't find any file matching "${query}".`);
        return new NextResponse('OK', { status: 200 });
      }

      // ── Step 2b: Course code keyword matching (e.g. "eng201", "send me CS 101 notes") ──
      const courseKeywords = extractCourseKeywords(text);
      if (courseKeywords.length > 0) {
        let matchingDbFiles = await getFilesByKeywords(courseKeywords);
        
        // Query Google Drive matching files in real-time
        const matchingDriveFiles: any[] = [];
        for (const kw of courseKeywords) {
          const driveFiles = await searchGDriveFiles(kw);
          matchingDriveFiles.push(...driveFiles);
        }
        
        // Deduplicate drive files by ID
        const seenDriveIds = new Set<string>();
        const uniqueDriveFiles = matchingDriveFiles.filter(f => {
          if (seenDriveIds.has(f.id)) return false;
          seenDriveIds.add(f.id);
          return true;
        });

        // Apply keyword context filtering (handouts, highlighted, mids, finals)
        const filteredDbFiles = filterFilesByContext(matchingDbFiles, text);
        const filteredDriveFiles = filterFilesByContext(uniqueDriveFiles, text);

        const totalFilesCount = filteredDbFiles.length + filteredDriveFiles.length;
        if (totalFilesCount > 0) {
          await sendAndLogTextMessage(sender, `Found ${totalFilesCount} file(s) matching your request:`);
          
          // Send Supabase files
          for (const file of filteredDbFiles) {
            try {
              await sendFileToUser(sender, file);
            } catch (err) {
              console.error(`Error sending DB file ${file.filename}:`, err);
            }
          }

          // Send Google Drive files directly (no downloading/uploading)
          for (const file of filteredDriveFiles) {
            try {
              await sendGDriveFileToUser(sender, file);
            } catch (err) {
              console.error(`Error sending Google Drive file ${file.name}:`, err);
            }
          }
          return new NextResponse('OK', { status: 200 });
        }
        // Course code detected but no files matched filters
        await sendAndLogTextMessage(sender, `No matching files found for course code and keyword filters in "${text}".`);
        return new NextResponse('OK', { status: 200 });
      }

      // ── Step 2c: Short direct input (filename, file ID, message ID) ──
      // Bypasses if message is a conversational greeting/short response (like "Hi", "Hello")
      const wordCount = text.split(/\s+/).length;
      if (wordCount <= 4 && !isConversationalQuery(text)) {
        // 1. Try Supabase
        const dbFile = await getFileByIdOrNameOrMessageId(text);
        if (dbFile) {
          const filtered = filterFilesByContext([dbFile], text);
          if (filtered.length > 0) {
            try {
              await sendAndLogTextMessage(sender, `Found matching file: ${dbFile.filename}`);
              await sendFileToUser(sender, dbFile);
              return new NextResponse('OK', { status: 200 });
            } catch (err) {
              console.error(`Error sending direct DB file:`, err);
            }
          }
        }

        // 2. Try Google Drive
        const driveFiles = await searchGDriveFiles(text);
        if (driveFiles.length > 0) {
          const filtered = filterFilesByContext(driveFiles, text);
          if (filtered.length > 0) {
            const driveFile = filtered[0];
            try {
              await sendAndLogTextMessage(sender, `Found matching Google Drive file: ${driveFile.name}`);
              await sendGDriveFileToUser(sender, driveFile);
              return new NextResponse('OK', { status: 200 });
            } catch (err) {
              console.error(`Error sending direct Drive file:`, err);
            }
          }
        }
      }

      // ── Step 2d: AI intent resolution (conversational messages, complex requests) ──
      let intent;
      try {
        intent = await processUserIntent(text, isSenderAdmin);
      } catch (aiErr) {
        console.error("AI processing error:", aiErr);
        intent = {
          type: 'chat',
          reply: "I'm here to help! You can:\n• Upload files by sending them directly\n• Retrieve files by name or course code (e.g. \"eng201\")\n• Use \"retrieve <filename>\" for specific files"
        };
      }
      
      switch (intent.type) {
        case 'add_admin':
          if (isSenderAdmin && intent.newNumber) {
            const success = await addAdmin(intent.newNumber, sender);
            const msg = success ? `Successfully added ${intent.newNumber} as admin.` : "Failed to add admin.";
            await sendAndLogTextMessage(sender, intent.reply || msg);
          } else {
            await sendAndLogTextMessage(sender, "Only existing admins can add new admins.");
          }
          break;

        case 'send_file':
          if (intent.filename) {
            try {
              // 1. Try Supabase first
              const dbFile = await getFileByIdOrNameOrMessageId(intent.filename);
              if (dbFile) {
                const filtered = filterFilesByContext([dbFile], text);
                if (filtered.length > 0) {
                  await sendAndLogTextMessage(sender, intent.reply || "Here is the file you requested.");
                  await sendFileToUser(sender, dbFile);
                  break;
                }
              }

              // 2. Try Google Drive (directly query and send download url)
              const driveFiles = await searchGDriveFiles(intent.filename);
              if (driveFiles.length > 0) {
                const filtered = filterFilesByContext(driveFiles, text);
                if (filtered.length > 0) {
                  const driveFile = filtered[0];
                  await sendAndLogTextMessage(sender, intent.reply || "Here is the file you requested.");
                  await sendGDriveFileToUser(sender, driveFile);
                } else {
                  await sendAndLogTextMessage(sender, `Sorry, no handouts/files matched your request details.`);
                }
              } else {
                await sendAndLogTextMessage(sender, `Sorry, I couldn't find a file named "${intent.filename}".`);
              }
            } catch (err) {
              console.error("Error in AI send_file intent:", err);
              await sendAndLogTextMessage(sender, "Sorry, I found the file but failed to send it. Please try again.");
            }
          }
          break;

        case 'chat':
        default:
          await sendAndLogTextMessage(sender, intent.reply || "I'm not sure how to help with that.");
          break;
      }
    }

    return new NextResponse('OK', { status: 200 });

  } catch (error) {
    console.error('Webhook Error:', error);
    // CRITICAL: Always return 200 to WhatsApp to prevent infinite retries.
    return new NextResponse('OK', { status: 200 });
  }
}
