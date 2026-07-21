import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const accountId = process.env.R2_ACCOUNT_ID!;
const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
const bucketName = process.env.R2_BUCKET_NAME!;

export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

export async function uploadFileToR2(key: string, buffer: Buffer, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await r2.send(command);
  return key;
}

export async function getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  
  return await getSignedUrl(r2, command, { expiresIn });
}

// If using a public R2 bucket mapped to a custom domain
export function getPublicUrl(key: string): string {
  return `${process.env.R2_PUBLIC_URL}/${key}`;
}

export async function getFileUrl(key: string): Promise<string> {
  if (process.env.R2_PUBLIC_URL) {
    return getPublicUrl(key);
  }
  return await getSignedDownloadUrl(key);
}

/**
 * Downloads the raw content of an R2 object and returns it as a UTF-8 string.
 * Used to read plain-text review files so they can be forwarded as WhatsApp
 * text messages instead of document attachments.
 */
export async function downloadFileContentFromR2(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });

  const response: GetObjectCommandOutput = await r2.send(command);

  if (!response.Body) {
    throw new Error(`R2 object "${key}" returned an empty body.`);
  }

  // response.Body is a ReadableStream in Node; collect chunks into a Buffer
  const chunks: Uint8Array[] = [];
  const stream = response.Body as any; // NodeJS.ReadableStream or Web ReadableStream
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  } else {
    // Web ReadableStream fallback
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}

