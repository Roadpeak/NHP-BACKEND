/**
 * Passport photographs.
 *
 * A face is biometric data under the Kenyan Data Protection Act, so it is
 * treated exactly like a National ID: encrypted at rest with AES-256-GCM,
 * served only through an endpoint behind the same authorisation as the
 * record it belongs to, and never given a public URL. There is no object
 * store to misconfigure and nothing for a CDN to cache.
 *
 * The photo is stored as a data URL rather than raw bytes because the whole
 * crypto layer is string-in, string-out; a second binary path would be a
 * second place for the encryption to be got wrong.
 */
import { encryptField, decryptField } from './crypto.js';

export class PhotoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

/**
 * The ceiling, after client-side resizing.
 *
 * A passport photo at 200×200 JPEG lands around 15KB. 200KB leaves room for
 * a phone that resizes badly while still refusing anything that is really a
 * document scan or a video frame — those belong in the record, not here.
 */
export const MAX_PHOTO_BYTES = 200 * 1024;

/** Only formats a browser can both produce and display. */
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The first bytes of each allowed format.
 *
 * Checked because a MIME type in a data URL is a claim by the caller, not a
 * fact. Without this, `data:image/jpeg;base64,<an HTML page>` is stored and
 * later served back with an image content type — which is how a stored XSS
 * gets into a system that thought it only held pictures.
 */
const MAGIC: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  // WebP is "RIFF....WEBP"; the first four bytes are enough to distinguish.
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

export interface ParsedPhoto {
  mime: string;
  bytes: Buffer;
}

/** Validates a data URL and returns its decoded bytes. */
export function parsePhoto(dataUrl: string): ParsedPhoto {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new PhotoError(
      'The photo must be a base64 data URL, e.g. data:image/jpeg;base64,…',
      'PHOTO_MALFORMED',
    );
  }

  const mime = match[1].toLowerCase();
  if (!ALLOWED.has(mime)) {
    throw new PhotoError(
      `${mime} is not an accepted photo format. Use JPEG, PNG or WebP.`,
      'PHOTO_WRONG_FORMAT',
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2], 'base64');
  } catch {
    throw new PhotoError('The photo could not be decoded', 'PHOTO_MALFORMED');
  }

  if (bytes.length === 0) {
    throw new PhotoError('The photo is empty', 'PHOTO_MALFORMED');
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new PhotoError(
      `The photo is ${Math.round(bytes.length / 1024)}KB; the limit is ` +
        `${MAX_PHOTO_BYTES / 1024}KB. Resize it before uploading.`,
      'PHOTO_TOO_LARGE',
    );
  }

  // The declared type must match what the bytes actually are.
  const expected = MAGIC.find((m) => m.mime === mime);
  const matches = expected?.bytes.every((b, i) => bytes[i] === b);
  if (!matches) {
    throw new PhotoError(
      'That file is not a valid image, whatever its name says.',
      'PHOTO_NOT_AN_IMAGE',
    );
  }

  return { mime, bytes };
}

/** Validates, then encrypts for storage. Returns what goes in the column. */
export function encryptPhoto(dataUrl: string): string {
  // Parsed first: an invalid photo must be refused before it is encrypted,
  // or the failure surfaces later as an undecodable blob.
  parsePhoto(dataUrl);
  return encryptField(dataUrl.trim());
}

/** Decrypts a stored photo back to its data URL, or null if there is none. */
export function decryptPhoto(stored: string | null): string | null {
  if (!stored) return null;
  try {
    return decryptField(stored);
  } catch {
    // A photo that will not decrypt is a corrupt row, not a reason to fail
    // the whole record — a clinician still needs the allergies.
    return null;
  }
}
