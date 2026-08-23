/**
 * HTTP layer.
 *
 * Deliberately thin. Every rule lives in the service modules and the
 * database; this file only translates HTTP to function calls and errors to
 * status codes. If a guarantee ever appears here and nowhere else, it is in
 * the wrong place — a route handler can be bypassed, a database trigger
 * cannot.
 *
 *   pnpm serve
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

import { searchByIdentifier } from './identity.js';
import { currentSession, canWriteClinical } from './practitioner.js';
import {
  searchDiagnoses,
  searchMedications,
  patientSummary,
  patientTimeline,
  openEncounter,
  recordDiagnosis,
  prescribe,
  checkPrescribing,
  keyResults,
  procedureHistory,
  ClinicalError,
} from './clinical.js';
import { filteredRecord, logAccess, accessHistory, ConsentError } from './consent.js';
import { recommend, symptomPicker, TriageError } from './triage.js';
import { findFacilities, FacilityError } from './facility.js';
import { IdentityError } from './identity.js';
import { PractitionerError } from './practitioner.js';
import {
  login,
  completeMfa,
  rotateRefreshToken,
  revokeAllSessions,
  verifyAccessToken,
  contextFromClaims,
  requirePractitioner,
  requireSelf,
  enrolTotp,
  confirmTotp,
  enrolSms,
  confirmSms,
  resendMfaCode,
  issueOtp,
  hashPassword,
  assertCsrf,
  generateCsrfToken,
  refreshCookieOptions,
  csrfCookieOptions,
  CSRF_COOKIE,
  CSRF_HEADER,
  AuthError,
  type AuthContext,
  type LoginResult,
} from './auth.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL } },
});

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Requests carry a correlation id that also lands in the access log, so a
  // support question can be traced from a browser tab to an audit row.
  genReqId: () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});

await app.register(cookie);

await app.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3100'],
  // Required for the refresh cookie to travel at all.
  credentials: true,
  exposedHeaders: ['x-csrf-token'],
});

/** Cookies are Secure everywhere except local development. */
const SECURE_COOKIES = process.env.NODE_ENV === 'production';

/**
 * Splits a login result: the refresh token goes into an httpOnly cookie the
 * page cannot read, and only the short-lived access token is returned in the
 * body. A refresh token in JSON would end up in localStorage or a variable
 * an injected script could reach.
 */
function sendSession(
  reply: { setCookie: (n: string, v: string, o: object) => void },
  result: LoginResult,
) {
  if (result.status !== 'AUTHENTICATED' || !result.refreshToken) return result;

  const csrf = generateCsrfToken();
  reply.setCookie('nhp_refresh', result.refreshToken, refreshCookieOptions(SECURE_COOKIES));
  reply.setCookie(CSRF_COOKIE, csrf, csrfCookieOptions(SECURE_COOKIES));

  return {
    status: result.status,
    accessToken: result.accessToken,
    // Deliberately NOT the refresh token.
    csrfToken: csrf,
  };
}

/**
 * RFC 7807 problem+json, per the API spec.
 *
 * Deliberately does NOT leak whether an identifier exists: a wrong ID and an
 * ID the caller may not see return the same shape.
 */
app.setErrorHandler((error, request, reply) => {
  if (error instanceof AuthError) {
    return reply.status(error.status).send({
      type: `https://nhp.health.go.ke/problems/${error.code.toLowerCase().replace(/_/g, '-')}`,
      title: 'AuthError',
      detail: error.message,
      code: error.code,
      instance: request.id,
    });
  }

  const known =
    error instanceof ClinicalError ||
    error instanceof ConsentError ||
    error instanceof TriageError ||
    error instanceof FacilityError ||
    error instanceof IdentityError ||
    error instanceof PractitionerError;

  if (known) {
    const code = (error as { code: string }).code;
    // Gate refusals are 403, not 400 — the request was well-formed, the
    // caller simply is not permitted.
    const forbidden = [
      'NO_OPEN_SESSION',
      'AFFILIATION_ENDED',
      'NO_ACTIVE_LICENCE',
      'SELF_ACCESS_REFUSED',
      'NOT_YOUR_CONSENT',
    ].includes(code);

    return reply.status(forbidden ? 403 : 400).send({
      type: `https://nhp.health.go.ke/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title: error.name,
      detail: error.message,
      code,
      instance: request.id,
    });
  }

  request.log.error({ err: error }, 'unhandled');
  return reply.status(500).send({
    type: 'https://nhp.health.go.ke/problems/internal',
    title: 'InternalError',
    detail: 'Something went wrong.',
    code: 'INTERNAL',
    instance: request.id,
  });
});

const v1 = '/api/v1';

// ------------------------------------------------------------------ health

app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`;
  return { status: 'ok', service: 'nhp-api' };
});

// ------------------------------------------------------------- vocabulary
// Public: these are reference data, not patient data.

app.get<{ Querystring: { q?: string } }>(`${v1}/vocab/diagnoses`, async (req) => {
  const q = req.query.q ?? '';
  return searchDiagnoses(prisma, q);
});

app.get<{ Querystring: { q?: string } }>(`${v1}/vocab/medications`, async (req) => {
  const q = req.query.q ?? '';
  return searchMedications(prisma, q);
});

app.get(`${v1}/vocab/symptoms`, async (req) => {
  const { ageYears, sex, lang } = req.query as {
    ageYears?: string;
    sex?: 'MALE' | 'FEMALE' | 'INTERSEX';
    lang?: 'en' | 'sw';
  };
  return symptomPicker(prisma, {
    ageYears: ageYears ? Number(ageYears) : 30,
    sex,
    lang: lang ?? 'en',
  });
});

// ---------------------------------------------------------------- sessions

/**
 * Resolves the caller from a bearer token.
 *
 * Replaces the X-Practitioner-Id header this server started with. Anything
 * that needs a clinical identity goes through requirePractitioner(), which
 * also refuses a privileged token whose second factor was never presented.
 */
async function contextFrom(req: { headers: Record<string, unknown> }): Promise<AuthContext> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AuthError('Sign in to continue', 'NO_SESSION');
  }
  return contextFromClaims(await verifyAccessToken(header.slice(7)));
}

async function practitionerFrom(req: { headers: Record<string, unknown> }): Promise<string> {
  return requirePractitioner(await contextFrom(req));
}

// -------------------------------------------------------------------- auth

app.post<{ Body: { phone: string; password: string } }>(
  `${v1}/auth/login`,
  async (req, reply) =>
    sendSession(
      reply,
      await login(prisma, {
        phone: req.body.phone,
        password: req.body.password,
        deviceHint: String(req.headers['user-agent'] ?? '').slice(0, 120),
      }),
    ),
);

app.post<{ Body: { mfaToken: string; code: string } }>(
  `${v1}/auth/mfa`,
  async (req, reply) =>
    sendSession(
      reply,
      await completeMfa(prisma, {
        mfaToken: req.body.mfaToken,
        code: req.body.code,
        deviceHint: String(req.headers['user-agent'] ?? '').slice(0, 120),
      }),
    ),
);

/**
 * Refresh.
 *
 * Reads the token from the httpOnly cookie, never the body. CSRF is checked
 * first because this endpoint is reachable by any origin that can make the
 * browser send the cookie — SameSite blocks the common cases, but defence
 * in depth is warranted for the one endpoint that mints sessions.
 */
app.post(`${v1}/auth/refresh`, async (req, reply) => {
  assertCsrf(req.cookies[CSRF_COOKIE], req.headers[CSRF_HEADER] as string | undefined);

  const token = req.cookies.nhp_refresh;
  if (!token) throw new AuthError('No session to refresh', 'NO_REFRESH_COOKIE');

  const rotated = await rotateRefreshToken(
    prisma,
    token,
    String(req.headers['user-agent'] ?? '').slice(0, 120),
  );

  return sendSession(reply, { status: 'AUTHENTICATED', ...rotated });
});

app.post(`${v1}/auth/logout`, async (req, reply) => {
  const ctx = await contextFrom(req);
  const result = await revokeAllSessions(prisma, ctx.accountId, 'USER_LOGOUT');

  // Clear both cookies, or the browser keeps presenting a dead token.
  reply.clearCookie('nhp_refresh', refreshCookieOptions(SECURE_COOKIES));
  reply.clearCookie(CSRF_COOKIE, csrfCookieOptions(SECURE_COOKIES));

  return result;
});

app.get(`${v1}/auth/me`, async (req) => {
  const ctx = await contextFrom(req);
  const session = ctx.practitionerId
    ? await currentSession(prisma, ctx.practitionerId)
    : null;
  return {
    accountId: ctx.accountId,
    practitionerId: ctx.practitionerId ?? null,
    ministryUserId: ctx.ministryUserId ?? null,
    personId: ctx.personId ?? null,
    mfaSatisfied: ctx.mfa,
    checkedInAt: session?.facility.name ?? null,
  };
});

app.post<{ Body: { label?: string } }>(`${v1}/auth/mfa/enrol`, async (req) => {
  const ctx = await contextFrom(req);
  return enrolTotp(prisma, ctx.accountId, req.body?.label ?? 'NHP account');
});

app.post<{ Body: { code: string } }>(`${v1}/auth/mfa/confirm`, async (req) => {
  const ctx = await contextFrom(req);
  return confirmTotp(prisma, ctx.accountId, req.body.code);
});

/**
 * SMS second factor.
 *
 * The primary channel for Kenya: authenticator apps assume a smartphone,
 * and a clinical officer on a feature phone has none.
 */
app.post(`${v1}/auth/mfa/sms/enrol`, async (req) => {
  const ctx = await contextFrom(req);
  return enrolSms(prisma, ctx.accountId);
});

app.post<{ Body: { code: string } }>(`${v1}/auth/mfa/sms/confirm`, async (req) => {
  const ctx = await contextFrom(req);
  return confirmSms(prisma, ctx.accountId, req.body.code);
});

/** Resend a login code. No session yet, so the mfaToken is the credential. */
app.post<{ Body: { mfaToken: string } }>(`${v1}/auth/mfa/resend`, async (req) =>
  resendMfaCode(prisma, req.body.mfaToken),
);

app.get(`${v1}/check-ins/current`, async (req) => {
  const session = await currentSession(prisma, await practitionerFrom(req));
  if (!session) return null;
  return {
    id: session.id,
    facilityId: session.facilityId,
    facilityName: session.facility.name,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    minutesRemaining: session.minutesRemaining,
    expiringSoon: session.expiringSoon,
  };
});

app.get(`${v1}/check-ins/can-write`, async (req) =>
  canWriteClinical(prisma, await practitionerFrom(req)),
);

// ----------------------------------------------------------------- persons

app.get<{ Querystring: { identifier?: string } }>(
  `${v1}/persons/search`,
  async (req, reply) => {
    const identifier = req.query.identifier;
    if (!identifier) {
      return reply.status(400).send({
        type: 'https://nhp.health.go.ke/problems/missing-identifier',
        title: 'BadRequest',
        detail: 'identifier is required',
        code: 'MISSING_IDENTIFIER',
        instance: req.id,
      });
    }

    const practitionerId = await practitionerFrom(req);
    const result = await searchByIdentifier(prisma, identifier);

    // Every search is logged, found or not. Denials are the fraud signal.
    if (result.match) {
      await logAccess(prisma, {
        personId: result.match.id,
        practitionerId,
        action: 'SEARCH',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: 'GRANTED',
        requestId: req.id,
      });
    }

    return result;
  },
);

app.get<{ Params: { nhpId: string } }>(
  `${v1}/persons/:nhpId/summary`,
  async (req) => {
    const practitionerId = await practitionerFrom(req);
    const gate = await canWriteClinical(prisma, practitionerId);

    const summary = await patientSummary(prisma, req.params.nhpId);

    // Consent filtering needs a session; without one the caller still sees
    // the Tier 1 banner, which must never be gated.
    let restrictedRecordsExist = false;
    let withheldCategories: string[] = [];

    if (gate.allowed) {
      const view = await filteredRecord(prisma, {
        personId: req.params.nhpId,
        practitionerId,
        facilityId: gate.facilityId,
        checkInId: gate.checkInId,
      });
      restrictedRecordsExist = view.restrictedRecordsExist;
      withheldCategories = view.withheldCategories;

      await logAccess(prisma, {
        personId: req.params.nhpId,
        practitionerId,
        checkInId: gate.checkInId,
        facilityId: gate.facilityId,
        action: 'VIEW_SUMMARY',
        tierReached: 'TIER_2_GENERAL',
        reason: 'ACTIVE_CONSULTATION',
        outcome: 'GRANTED',
        requestId: req.id,
      });
    }

    return { ...summary, restrictedRecordsExist, withheldCategories };
  },
);

app.get<{ Params: { nhpId: string }; Querystring: { limit?: string } }>(
  `${v1}/persons/:nhpId/encounters`,
  async (req) =>
    patientTimeline(prisma, req.params.nhpId, {
      limit: req.query.limit ? Number(req.query.limit) : 20,
    }),
);

app.get<{ Params: { nhpId: string } }>(
  `${v1}/persons/:nhpId/results`,
  async (req) => {
    await practitionerFrom(req);
    return keyResults(prisma, req.params.nhpId);
  },
);

app.get<{ Params: { nhpId: string } }>(
  `${v1}/persons/:nhpId/procedures`,
  async (req) => {
    await practitionerFrom(req);
    return procedureHistory(prisma, req.params.nhpId);
  },
);

app.get<{ Params: { nhpId: string } }>(
  `${v1}/persons/:nhpId/access-log`,
  async (req) => accessHistory(prisma, req.params.nhpId),
);

// ---------------------------------------------------------------- clinical

app.post<{
  Body: {
    personId: string;
    kind: Parameters<typeof openEncounter>[1]['kind'];
    chiefComplaint: string;
  };
}>(`${v1}/encounters`, async (req) =>
  openEncounter(prisma, {
    practitionerId: await practitionerFrom(req),
    personId: req.body.personId,
    kind: req.body.kind,
    chiefComplaint: req.body.chiefComplaint,
  }),
);

app.post<{
  Params: { id: string };
  Body: { icd11Code: string; clinicalStatus?: 'SUSPECTED' | 'CONFIRMED'; isChronic?: boolean };
}>(`${v1}/encounters/:id/conditions`, async (req) =>
  recordDiagnosis(prisma, {
    practitionerId: await practitionerFrom(req),
    encounterId: req.params.id,
    icd11Code: req.body.icd11Code,
    clinicalStatus: req.body.clinicalStatus,
    isChronic: req.body.isChronic,
  }),
);

app.post<{
  Params: { id: string };
  Body: {
    kemlCode: string;
    doseAmount: number;
    doseUnit: string;
    frequency: string;
    durationDays?: number;
    overrideReason?: string;
    isPregnant?: boolean;
    ageYears?: number;
  };
}>(`${v1}/encounters/:id/medications`, async (req) =>
  prescribe(prisma, {
    practitionerId: await practitionerFrom(req),
    encounterId: req.params.id,
    ...req.body,
  }),
);

app.post<{
  Body: { personId: string; kemlCode: string; isPregnant?: boolean; ageYears?: number };
}>(`${v1}/clinical/prescribing-check`, async (req) =>
  checkPrescribing(prisma, req.body),
);

// ------------------------------------------------------------------ triage

app.post<{
  Body: {
    symptoms: string[];
    ageYears: number;
    countyId?: string;
    subcountyId?: string;
    location?: { latitude: number; longitude: number };
  };
}>(`${v1}/triage/recommend`, async (req) => recommend(prisma, req.body));

// --------------------------------------------------------------- facilities

app.get(`${v1}/facilities`, async (req) => {
  const { capabilities, countyId, limit } = req.query as {
    capabilities?: string;
    countyId?: string;
    limit?: string;
  };
  return findFacilities(prisma, {
    requiredCapabilities: capabilities ? capabilities.split(',') : undefined,
    countyId,
    limit: limit ? Number(limit) : 20,
  });
});

// ------------------------------------------------------------------- start

const PORT = Number(process.env.PORT ?? 4000);

// JWT_SECRET is validated on first use, but failing at startup is far
// better than failing on a clinician's first login.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(
    'REFUSING TO START: JWT_SECRET is missing or shorter than 32 characters.',
  );
  process.exit(1);
}

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`NHP API on :${PORT}${v1}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
