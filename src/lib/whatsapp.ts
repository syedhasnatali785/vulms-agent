import axios from 'axios';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN!;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;

const whatsappApi = axios.create({
  baseURL: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

export async function sendTextMessage(to: string, text: string) {
  try {
    const response = await whatsappApi.post('/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    });
    return response.data;
  } catch (error: any) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

export async function sendMediaMessage(to: string, mediaType: 'image' | 'video' | 'document', mediaUrl: string, caption?: string) {
  try {
    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: mediaType,
    };

    payload[mediaType] = { link: mediaUrl };
    if (caption) {
      if (mediaType === 'document') {
        payload[mediaType].filename = caption;
      } else {
        payload[mediaType].caption = caption;
      }
    }

    const response = await whatsappApi.post('/messages', payload);
    return response.data;
  } catch (error: any) {
    console.error(`Error sending ${mediaType}:`, error.response?.data || error.message);
    throw error;
  }
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer, mimeType: string }> {
  try {
    // 1. Get Media URL
    const mediaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    
    const mediaUrl = mediaRes.data.url;
    const mimeType = mediaRes.data.mime_type;

    // 2. Download the binary data
    const downloadRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });

    return {
      buffer: Buffer.from(downloadRes.data),
      mimeType,
    };
  } catch (error: any) {
    console.error('Error downloading WhatsApp media:', error.response?.data || error.message);
    throw error;
  }
}
