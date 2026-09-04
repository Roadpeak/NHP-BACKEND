/**
 * Notifications — SMS first.
 *
 * SMS is not a fallback here, it is the primary channel. Authenticator apps
 * assume a smartphone and a working app store; a clinical officer at a
 * Level 3 facility on a feature phone has neither, and a system that
 * requires TOTP excludes exactly the staff who most need to be included.
 *
 * Africa's Talking is the gateway, per the blueprint: Kenya-native, and it
 * reaches feature phones.
 *
 * Two rules the rest of the system depends on:
 *
 *   1. Sending is NEVER awaited on a path that must not block. A clinician
 *      treating an unconscious patient must not wait for a gateway.
 *   2. Message bodies carry no health content. Phones are shared in many
 *      Kenyan households, and a lock-screen preview is a disclosure.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export class NotifyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

export interface SmsMessage {
  /** E.164, e.g. +254712345678. */
  to: string;
  body: string;
  /** Groups messages in the gateway's reporting. */
  purpose: 'MFA' | 'OTP' | 'BREAK_GLASS' | 'APPOINTMENT' | 'IMMUNISATION';
}

export interface SmsResult {
  accepted: boolean;
  providerId?: string;
  cost?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
}

/**
 * Africa's Talking.
 *
 * Deliberately fails soft: a gateway outage must not take down login for
 * everyone, and it must never block an emergency notification. Callers get
 * `accepted: false` and decide.
 */
export class AfricasTalkingProvider implements SmsProvider {
  readonly name = 'AFRICAS_TALKING';

  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly senderId?: string,
    private readonly baseUrl = 'https://api.africastalking.com/version1',
  ) {}

  async send(message: SmsMessage): Promise<SmsResult> {
    const body = new URLSearchParams({
      username: this.username,
      to: message.to,
      message: message.body,
      ...(this.senderId ? { from: this.senderId } : {}),
    });

    try {
      const response = await fetch(`${this.baseUrl}/messaging`, {
        method: 'POST',
        headers: {
          apiKey: this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        // A hung gateway must not hold a request open indefinitely.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return { accepted: false, error: `Gateway returned ${response.status}` };
      }

      const payload = (await response.json()) as {
        SMSMessageData?: {
          Recipients?: Array<{ status: string; messageId: string; cost: string }>;
        };
      };

      const recipient = payload.SMSMessageData?.Recipients?.[0];
      if (!recipient || recipient.status !== 'Success') {
        return { accepted: false, error: recipient?.status ?? 'No recipient in response' };
      }

      return { accepted: true, providerId: recipient.messageId, cost: recipient.cost };
    } catch (err) {
      return {
        accepted: false,
        error: err instanceof Error ? err.message : 'Gateway unreachable',
      };
    }
  }
}

/**
 * Development provider.
 *
 * Prints instead of sending, and keeps a buffer tests can read. Never
 * enabled in production — see `resolveSmsProvider`.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'CONSOLE';
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<SmsResult> {
    this.sent.push(message);
    console.log(`\n  [SMS → ${message.to}] ${message.body}\n`);
    return { accepted: true, providerId: `console-${this.sent.length}` };
  }

  /** The most recent message to a number, for tests. */
  lastTo(phone: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === phone);
  }

  clear() {
    this.sent.length = 0;
  }
}

let provider: SmsProvider | null = null;

/**
 * The configured provider.
 *
 * Refuses to fall back to the console in production: an SMS silently
 * printed to a log instead of sent means a clinician never receives their
 * code and a patient is never told about an emergency access.
 */
export function resolveSmsProvider(): SmsProvider {
  if (provider) return provider;

  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;

  if (username && apiKey) {
    provider = new AfricasTalkingProvider(username, apiKey, process.env.AT_SENDER_ID);
    return provider;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new NotifyError(
      'No SMS provider configured. Set AT_USERNAME and AT_API_KEY — the ' +
        'console provider must never run in production, or codes and ' +
        'break-glass alerts would be printed to a log instead of sent.',
      'SMS_NOT_CONFIGURED',
    );
  }

  provider = new ConsoleSmsProvider();
  return provider;
}

/** For tests. */
export function setSmsProvider(next: SmsProvider | null) {
  provider = next;
}

// ---------------------------------------------------------------- messages

/**
 * Message bodies.
 *
 * No health content, no patient names, no facility-implied diagnosis.
 * Phones are shared in many Kenyan households and a lock-screen preview is
 * visible to whoever is holding the handset.
 */
export const messages = {
  mfaCode: (code: string, minutes: number) =>
    `${code} is your NHP sign-in code. It expires in ${minutes} minutes. ` +
    `NHP will never ask you for this code.`,

  registrationCode: (code: string, minutes: number) =>
    `${code} is your NHP verification code, valid for ${minutes} minutes.`,

  /**
   * Break-glass notification.
   *
   * Names the facility and the time, because the patient needs enough to
   * query it — but says nothing about what was seen or why they were there.
   */
  breakGlass: (facilityName: string, when: Date) =>
    `Your NHP health record was opened under emergency access at ` +
    `${facilityName} on ${when.toISOString().slice(0, 16).replace('T', ' ')}. ` +
    `If this was not expected, call 147.`,

  consentRequest: (facilityName: string, code: string) =>
    `${code} is your NHP code to share restricted records with ` +
    `${facilityName}. Only share it with the clinician treating you.`,
};

// ------------------------------------------------------------------ sending

/**
 * Sends without blocking the caller.
 *
 * Used where a failure must not stop the clinical path — break-glass above
 * all. The promise is deliberately not returned.
 */
export function sendAsync(message: SmsMessage): void {
  void resolveSmsProvider()
    .send(message)
    .then((result) => {
      if (!result.accepted) {
        console.error(
          `[notify] SMS to ${maskPhone(message.to)} failed: ${result.error}`,
        );
      }
    })
    .catch((err) => {
      console.error(`[notify] SMS threw: ${err instanceof Error ? err.message : err}`);
    });
}

/** Sends and waits. Only where the caller genuinely needs the outcome. */
export async function send(message: SmsMessage): Promise<SmsResult> {
  return resolveSmsProvider().send(message);
}

/** Logs and errors must never carry a full number. */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '***';
  return `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}

/**
 * The sign-in code, for a deployment that has no SMS gateway yet.
 *
 * Returned in the login response and shown above the code field, so a
 * clinician can complete the second factor while the Africa's Talking
 * account is still being provisioned. It is a stopgap with an expiry date,
 * not a feature.
 *
 * Every guard the test hooks already enforce applies here, and for the same
 * reasons:
 *
 *   - NEVER in production. Checked first and on its own.
 *   - Only when the SMS provider is the console one. The instant a real
 *     gateway is configured this returns undefined and the code goes to the
 *     handset instead — no code change, no redeploy, no flag to remember to
 *     turn off. That is the point: this switches itself off.
 *   - Only when NHP_SHOW_OTP is explicitly set. It does not default on, so
 *     a developer running the API locally does not silently get an OTP
 *     printed into every login response.
 *
 * It is NOT an authentication bypass: the code is the same one the console
 * provider already prints to stdout, and the second factor still has to be
 * entered and verified. What it changes is who can see stdout.
 */
export function devVisibleOtp(code: string): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  if (process.env.NHP_SHOW_OTP !== '1') return undefined;

  // A real gateway means the code reached a real handset. Echoing it into
  // an HTTP response at that point would be a genuine disclosure rather
  // than a convenience.
  if (!(resolveSmsProvider() instanceof ConsoleSmsProvider)) return undefined;

  return code;
}
