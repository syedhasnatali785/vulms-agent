import { NextResponse } from 'next/server';
import { isAdmin, addAdmin, saveFileMetadata, getFileByName } from '@/lib/supabase';
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
      if (!isSenderAdmin) {
        await sendTextMessage(sender, "Sorry, only administrators can upload files to the AI agent.");
        return new NextResponse('OK', { status: 200 });
      }

      const mediaId = message[message.type].id;
      const caption = message[message.type].caption || '';
      
      try {
        await sendTextMessage(sender, "Downloading and saving your file...");
        const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
        
        // Generate a filename or use caption
        const ext = mimeType.split('/')[1] || 'bin';
        const rawFilename = caption || `file_${Date.now()}`;
        const filename = `${rawFilename.replace(/\\s+/g, '_')}.${ext}`;
        const r2Key = `uploads/${Date.now()}_${filename}`;
        
        await uploadFileToR2(r2Key, buffer, mimeType);
        await saveFileMetadata(rawFilename, r2Key, mimeType, sender);
        
        await sendTextMessage(sender, `File successfully saved as: ${rawFilename}`);
      } catch (e: any) {
        console.error("Upload Error:", e);
        await sendTextMessage(sender, "Failed to process the upload. Make sure the file is supported.");
      }
      return new NextResponse('OK', { status: 200 });
    }

    // 2. Handle Text Messages via AI
    if (message.type === 'text') {
      const text = message.text.body;
      
      const intent = await processUserIntent(text, isSenderAdmin);
      
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
            const file = await getFileByName(intent.filename);
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
