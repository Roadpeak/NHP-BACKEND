/**
 * HTTP layer.
 *
 * Deliberately thin. Every rule lives in the service modules and the
 * database; this file only translates HTTP to function calls and errors to
 * status codes. If a guarantee ever appears here and nowhere else, it is in
 * the wrong place — a route handler can be bypassed, a database trigger
 * cannot.
 *
 * `buildApp()` returns the configured app without listening. `server.ts`
 * starts it; `test/http.test.ts` injects into it.
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
  resolvePersonId,
  ClinicalError,
} from './clinical.js';
import { filteredRecord, logAccess, accessHistory, ConsentError } from './consent.js';
import { recommend, symptomPicker, TriageError } from './triage.js';
import {
  citizenSummary,
  citizenTimeline,
  raiseDispute,
  uiStrings,
  CitizenError,
  type Lang,
} from './citizen.js';
import { findFacilities, FacilityError } from './facility.js';
import {
  burdenByCounty,
  burdenBySubcounty,
  referralClosureByCounty,
  workforceByCounty,
  careGaps,
  notifiableSignals,
  provenance,
  periodFrom,
  rollupConditions,
  AnalyticsError,
  SUPPRESSION_THRESHOLD,
} from './analytics.js';
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
  requireMinistry,
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

/**
 * Builds the Fastify app WITHOUT listening on a port.
 *
 * Split out from `server.ts` so tests can drive the real application over
 * `app.inject()` — the same routes, the same error handler, the same cookie
 * and CORS plugins — without binding a port or calling `process.exit`.
 *
 * This split exists because three defects reached `main` that no service-level
 * test could see: two routes with no authorization at all, and an identifier
 * mismatch between what a route receives and what its service expects. Both
 * classes of bug live in the gap between the handler and the service, which
 * is precisely the gap only an HTTP-level test covers.
 */
export async function buildApp(prismaOverride?: PrismaClient) {
  const prisma =
    prismaOverride ??
    new PrismaClient({
      datasources: {
        db: { url: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL },
      },
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
    // Schema validation failures are the caller's error, and must not fall
    // through to the 500 branch below. Deliberately does not echo the
    // offending value back — a malformed login body may contain a password.
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({
        type: 'https://nhp.health.go.ke/problems/malformed-request',
        title: 'ValidationError',
        detail: 'The request body is missing a required field or has the wrong shape.',
        code: 'MALFORMED_REQUEST',
        instance: request.id,
      });
    }

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
      error instanceof AnalyticsError ||
      error instanceof CitizenError ||
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

  /**
   * The `Body` generic below is a compile-time claim, not a runtime check —
   * a request missing `phone` still reached the service, which called
   * `.replace()` on undefined and produced a 500. A malformed request is
   * the caller's error and must be answered as one, so these carry a real
   * schema: Fastify rejects a bad body with 400 before the handler runs.
   */
  const loginSchema = {
    body: {
      type: 'object',
      required: ['phone', 'password'],
      properties: {
        phone: { type: 'string', minLength: 1 },
        password: { type: 'string', minLength: 1 },
      },
    },
  };

  app.post<{ Body: { phone: string; password: string } }>(
    `${v1}/auth/login`,
    { schema: loginSchema },
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
    {
      schema: {
        body: {
          type: 'object',
          required: ['mfaToken', 'code'],
          properties: {
            mfaToken: { type: 'string', minLength: 1 },
            code: { type: 'string', minLength: 1 },
          },
        },
      },
    },
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

      const personId = await resolvePersonId(prisma, req.params.nhpId);
      const summary = await patientSummary(prisma, personId);

      // Consent filtering needs a session; without one the caller still sees
      // the Tier 1 banner, which must never be gated.
      let restrictedRecordsExist = false;
      let withheldCategories: string[] = [];

      if (gate.allowed) {
        const view = await filteredRecord(prisma, {
          personId,
          practitionerId,
          facilityId: gate.facilityId,
          checkInId: gate.checkInId,
        });
        restrictedRecordsExist = view.restrictedRecordsExist;
        withheldCategories = view.withheldCategories;

        await logAccess(prisma, {
          // The internal id, not the typed number — an access log keyed on a
          // value that matches no person row is an audit trail of nobody.
          personId,
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

  // `:nhpId` is the number a clinician types (NHP-XXXX-XXXX); the services
  // below key on the internal person id. `resolvePersonId` bridges the two —
  // without it these queries silently matched nothing and returned [].

  app.get<{ Params: { nhpId: string }; Querystring: { limit?: string } }>(
    `${v1}/persons/:nhpId/encounters`,
    async (req) => {
      // This route previously had NO auth check: an unauthenticated caller
      // got HTTP 200 on a patient's clinical timeline. It only ever returned
      // [] because of the id-resolution bug above, which is not a control.
      await practitionerFrom(req);
      return patientTimeline(prisma, await resolvePersonId(prisma, req.params.nhpId), {
        limit: req.query.limit ? Number(req.query.limit) : 20,
      });
    },
  );

  app.get<{ Params: { nhpId: string } }>(
    `${v1}/persons/:nhpId/results`,
    async (req) => {
      await practitionerFrom(req);
      return keyResults(prisma, await resolvePersonId(prisma, req.params.nhpId));
    },
  );

  app.get<{ Params: { nhpId: string } }>(
    `${v1}/persons/:nhpId/procedures`,
    async (req) => {
      await practitionerFrom(req);
      return procedureHistory(prisma, await resolvePersonId(prisma, req.params.nhpId));
    },
  );

  app.get<{ Params: { nhpId: string } }>(
    `${v1}/persons/:nhpId/access-log`,
    async (req) => {
      // Also previously unauthenticated. Who has read a record is itself
      // sensitive — it names the clinicians and facilities a patient attended.
      await practitionerFrom(req);
      return accessHistory(prisma, await resolvePersonId(prisma, req.params.nhpId));
    },
  );

  // ---------------------------------------------------------------- ministry
  //
  // Every route here reads AGGREGATES. There is deliberately no endpoint that
  // returns a patient list, because the tables these queries touch have never
  // held a person_id. The absence is structural, not a permission check.

  // `periodFrom` lives in analytics.ts — it encodes the day-grain of the
  // aggregate tables, which is a property of the data, not of HTTP.

  app.get(`${v1}/analytics/burden`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    const { icd11Code, chapter } = req.query as { icd11Code?: string; chapter?: string };
    return burdenByCounty(prisma, { ...periodFrom(req.query as never), icd11Code, chapter });
  });

  app.get<{ Params: { countyId: string } }>(
    `${v1}/analytics/burden/:countyId`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx);
      const { icd11Code, chapter } = req.query as { icd11Code?: string; chapter?: string };
      // Refuses a subcounty breakdown of a restricted chapter outright — those
      // aggregate at county level only, even for an Analyst.
      return burdenBySubcounty(prisma, {
        countyId: req.params.countyId,
        ...periodFrom(req.query as never),
        icd11Code,
        chapter,
      });
    },
  );

  app.get(`${v1}/analytics/referral-closure`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return referralClosureByCounty(prisma, periodFrom(req.query as never));
  });

  app.get(`${v1}/analytics/workforce`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    const { from } = periodFrom(req.query as never);
    return workforceByCounty(prisma, { since: from });
  });

  app.get(`${v1}/analytics/care-gaps`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return careGaps(prisma);
  });

  app.get(`${v1}/analytics/surveillance`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return notifiableSignals(prisma, periodFrom(req.query as never));
  });

  /**
   * Provenance.
   *
   * A national health figure with no stated denominator, period or
   * completeness rate is a number someone will misquote in a press
   * conference, so the dashboard carries it alongside every count.
   */
  app.get(`${v1}/analytics/provenance`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return {
      ...(await provenance(prisma, periodFrom(req.query as never))),
      suppressionNote:
        `Cells below ${SUPPRESSION_THRESHOLD} cases are suppressed, with ` +
        'complementary suppression so no hidden cell can be recovered by subtraction.',
    };
  });

  /** Reference data for the map: counties and their codes. */
  app.get(`${v1}/analytics/counties`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return prisma.county.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
  });

  /** Triggers the nightly rollup. Normally a cron job. */
  app.post(`${v1}/analytics/rollup`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);
    return rollupConditions(prisma, periodFrom(req.query as never));
  });

  // ----------------------------------------------------------------- citizen
  // A citizen reads their OWN record. requireSelf compares in constant time,
  // because ids are guessable in shape and an attacker with many attempts
  // could otherwise probe for near-misses.

  app.get(`${v1}/persons/me/summary`, async (req) => {
    const ctx = await contextFrom(req);
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }
    const lang = ((req.query as { lang?: string }).lang ?? 'en') as Lang;
    return {
      ...(await citizenSummary(prisma, ctx.personId, lang)),
      ui: uiStrings(lang),
    };
  });

  app.get(`${v1}/persons/me/visits`, async (req) => {
    const ctx = await contextFrom(req);
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }
    const { lang = 'en', limit } = req.query as { lang?: Lang; limit?: string };
    return citizenTimeline(prisma, ctx.personId, {
      lang,
      limit: limit ? Number(limit) : 20,
    });
  });

  app.get(`${v1}/persons/me/access-log`, async (req) => {
    const ctx = await contextFrom(req);
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }
    return accessHistory(prisma, ctx.personId);
  });

  app.post<{ Body: { encounterId: string; note: string } }>(
    `${v1}/persons/me/disputes`,
    async (req) => {
      const ctx = await contextFrom(req);
      if (!ctx.personId) {
        throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
      }
      // A dispute opens a review; it never writes to the clinical row.
      return raiseDispute(prisma, {
        personId: requireSelf(ctx, ctx.personId),
        encounterId: req.body.encounterId,
        note: req.body.note,
      });
    },
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


  return app;
}
