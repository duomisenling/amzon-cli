export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function parseMintApi(value) {
  return value === 'sp-api' || value === 'ads' ? value : null;
}

export async function readRequestBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
