/**
 * Field encryption and blind indexing.
 *
 * National IDs, phone numbers and names are encrypted at rest. But a facility
 * must be able to search by National ID, and you cannot search ciphertext
 * that is randomised — so each encrypted identifier also carries a *blind
 * index*: HMAC(pepper, normalise(value)).
 *
 * The property that matters: an attacker with a database dump gets neither
 * the identifiers nor a way to test guesses at scale, because the pepper
 * lives outside the database. Equality lookup still works.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 8) {
    throw new Error(
      `${name} is missing or too short. In production this belongs in a KMS, ` +
        'never in a file.',
    );
  }
  return v;
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) {
    // Derived, not used raw, so the env var need not be exactly 32 bytes.
    cachedKey = scryptSync(requireEnv('FIELD_ENCRYPTION_KEY'), 'nhp-field-v1', 32);
  }
  return cachedKey;
}

/**
 * Normalisation is security-critical: "39104882", " 39104882 " and
 * "39-104-882" must produce the same blind index, or the same person
 * registers twice and their history splits.
 */
export function normaliseIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/[\s\-/.]/g, '');
}

/** Kenyan numbers arrive as 0712…, +254712…, 254712…. Store one form. */
export function normalisePhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+254')) return digits;
  if (digits.startsWith('254')) return `+${digits}`;
  if (digits.startsWith('0')) return `+254${digits.slice(1)}`;
  return digits.startsWith('+') ? digits : `+254${digits}`;
}

/** Deterministic lookup token. Same input, same output, always. */
export function blindIndex(value: string, normalise = normaliseIdentifier): string {
  return createHmac('sha256', requireEnv('BLIND_INDEX_PEPPER'))
    .update(normalise(value))
    .digest('hex');
}

/** Randomised — the same plaintext encrypts differently every time. */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptField(payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Human-readable NHP number: NHP-XXXX-XXXX.
 * Crockford base32 minus I, L, O, U — so it cannot be misread over a phone
 * and cannot accidentally spell anything.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateDisplayNumber(): string {
  const pick = () =>
    Array.from(randomBytes(4))
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join('');
  return `NHP-${pick()}-${pick()}`;
}
