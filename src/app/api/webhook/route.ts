import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByIdOrNameOrMessageId, extractKeywords, getFilesByKeywords } from '@/lib/supabase';
import { downloadWhatsAppMedia, sendTextMessage, sendMediaMessage } from '@/lib/whatsapp';
import { uploadFileToR2, getSignedDownloadUrl } from '@/lib/r2';
import { processUserIntent } from '@/lib/ai';

// Vercel serverless function max duration (Hobby plan is restricted to 10s anyway, but this is good practice if upgraded)
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

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

    const sender = message.from;
    const isSenderAdmin = await isAdmin(sender);

    // 1. Handle File Uploads (Media)
    if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
      const mediaId = message[message.type].id;
      const caption = message[message.type].caption || '';
      const messageId = message.id; // WhatsApp Message ID
      
      try {
        await sendTextMessage(sender, "Downloading and saving your file...");
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
        
        const r2Key = `uploads/${Date.now()}_${filename}`;
        
        await uploadFileToR2(r2Key, buffer, mimeType);
        const savedFile = await saveFileMetadata(filename, r2Key, mimeType, sender, messageId);
        
        let successMessage = `File successfully saved!\n\n` +
          `📂 Filename: ${filename}\n`;
        
        if (savedFile) {
          successMessage += `🆔 File ID: ${savedFile.id}\n`;
        }
        successMessage += `✉️ Message ID: ${messageId}\n\n` +
          `You can retrieve this file anytime by typing "retrieve ${savedFile?.id || filename}" or "retrieve ${messageId}".`;
        
        await sendTextMessage(sender, successMessage);
      } catch (e: any) {
        console.error("Upload Error:", e);
        await sendTextMessage(sender, "Failed to process the upload. Make sure the file is supported.");
      }
      return new NextResponse('OK', { status: 200 });
    }

    // 2. Handle Text Messages
    if (message.type === 'text') {
      const text = message.text.body.trim();

      // 2a. Direct file lookup (non-conversational messages)
      // Check if the text itself matches a file ID, message ID, or filename directly
      const isConversational = /^(hi|hello|hey|yes|no|ok|okay|help|admin|who|what|why|how|please|thank|thanks)\b/i.test(text);
      if (!isConversational) {
        const directFile = await getFileByIdOrNameOrMessageId(text);
        if (directFile) {
          try {
            const presignedUrl = await getSignedDownloadUrl(directFile.r2_key);
            const mediaType = directFile.mime_type.startsWith('image') ? 'image' 
                            : directFile.mime_type.startsWith('video') ? 'video' 
                            : 'document';
            await sendTextMessage(sender, `Found matching file: ${directFile.filename}`);
            await sendMediaMessage(sender, mediaType, presignedUrl, directFile.filename);
            return new NextResponse('OK', { status: 200 });
          } catch (err) {
            console.error(`Error sending direct file ${directFile.filename}:`, err);
          }
        }
      }

      // 2b. Automatic Keyword/Similarity Matching from Sentences
      const keywords = extractKeywords(text);
      if (keywords.length > 0) {
        const matchingFiles = await getFilesByKeywords(keywords);
        if (matchingFiles.length > 0) {
          await sendTextMessage(sender, `Automatically found ${matchingFiles.length} file(s) matching your request:`);
          for (const file of matchingFiles) {
            try {
              const presignedUrl = await getSignedDownloadUrl(file.r2_key);
              const mediaType = file.mime_type.startsWith('image') ? 'image' 
                              : file.mime_type.startsWith('video') ? 'video' 
                              : 'document';
              await sendMediaMessage(sender, mediaType, presignedUrl, file.filename);
            } catch (err) {
              console.error(`Error sending matching file ${file.filename}:`, err);
            }
          }
          return new NextResponse('OK', { status: 200 });
        }
      }
      
      // 2c. Direct command matching for retrieval (case-insensitive fallback)
      const retrieveMatch = text.match(/^(?:retrieve|get|download)\s+(.+)$/i);
      if (retrieveMatch) {
        const query = retrieveMatch[1].trim();
        await sendTextMessage(sender, `Looking up file matching: "${query}"...`);
        const file = await getFileByIdOrNameOrMessageId(query);
        if (file) {
          try {
            const presignedUrl = await getSignedDownloadUrl(file.r2_key);
            const mediaType = file.mime_type.startsWith('image') ? 'image' 
                            : file.mime_type.startsWith('video') ? 'video' 
                            : 'document';
                            
            await sendTextMessage(sender, `Here is the requested file: ${file.filename}`);
            await sendMediaMessage(sender, mediaType, presignedUrl, file.filename);
          } catch (err) {
            console.error("Error generating URL or sending media:", err);
            await sendTextMessage(sender, "Sorry, I found the file but failed to retrieve it from storage.");
          }
        } else {
          await sendTextMessage(sender, `Sorry, I couldn't find any file matching "${query}".`);
        }
        return new NextResponse('OK', { status: 200 });
      }
      
      // 2d. Pass to AI for intent resolution
      let intent;
      try {
        intent = await processUserIntent(text, isSenderAdmin);
      } catch (aiErr) {
        console.error("AI processing error, falling back to simple chat response:", aiErr);
        intent = {
          type: 'chat',
          reply: "I'm here to help, but I'm currently experiencing some technical difficulties with my AI brain. You can upload files, retrieve them using 'retrieve <filename>', or ask for files by sending their name/course code!"
        };
      }
      
      switch (intent.type) {
        case 'add_admin':
          if (isSenderAdmin && intent.newNumber) {
            const success = await addAdmin(intent.newNumber, sender);
            const msg = success ? `Successfully added ${intent.newNumber} as admin.` : "Failed to add admin.";
            await sendTextMessage(sender, intent.reply || msg);
          } else {
            await sendTextMessage(sender, "Only existing admins can add new admins.");
          }
          break;

        case 'send_file':
          if (intent.filename) {
            const file = await getFileByIdOrNameOrMessageId(intent.filename);
            if (file) {
              const presignedUrl = await getSignedDownloadUrl(file.r2_key);
              const mediaType = file.mime_type.startsWith('image') ? 'image' 
                              : file.mime_type.startsWith('video') ? 'video' 
                              : 'document';
                              
              await sendTextMessage(sender, intent.reply || "Here is the file you requested.");
              await sendMediaMessage(sender, mediaType, presignedUrl, file.filename);
            } else {
              await sendTextMessage(sender, `Sorry, I couldn't find a file named ${intent.filename}.`);
            }
          }
          break;

        case 'chat':
        default:
          await sendTextMessage(sender, intent.reply || "I'm not sure how to help with that.");
          break;
      }
    }

    return new NextResponse('OK', { status: 200 });

  } catch (error) {
    console.error('Webhook Error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
