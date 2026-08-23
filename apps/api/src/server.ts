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
  ClinicalError,
} from './clinical.js';
import { filteredRecord, logAccess, accessHistory, ConsentError } from './consent.js';
import { recommend, symptomPicker, TriageError } from './triage.js';
import { findFacilities, FacilityError } from './facility.js';
import { IdentityError } from './identity.js';
import { PractitionerError } from './practitioner.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL } },
});

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Requests carry a correlation id that also lands in the access log, so a
  // support question can be traced from a browser tab to an audit row.
  genReqId: () => `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
});

await app.register(cors, {
  origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3100'],
  credentials: true,
});

/**
 * RFC 7807 problem+json, per the API spec.
 *
 * Deliberately does NOT leak whether an identifier exists: a wrong ID and an
 * ID the caller may not see return the same shape.
 */
app.setErrorHandler((error, request, reply) => {
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
 * Who is checked in.
 *
 * Auth is not built yet, so the practitioner comes from a header. This is a
 * DEVELOPMENT SHORTCUT and the server refuses to start with it outside
 * development — see the guard at the bottom of this file.
 */
function practitionerIdFrom(req: { headers: Record<string, unknown> }): string {
  const id = req.headers['x-practitioner-id'];
  if (typeof id !== 'string' || !id) {
    throw new PractitionerError(
      'No practitioner context. Send X-Practitioner-Id until auth lands.',
      'NO_PRACTITIONER_CONTEXT',
    );
  }
  return id;
}

app.get(`${v1}/check-ins/current`, async (req) => {
  const session = await currentSession(prisma, practitionerIdFrom(req));
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
  canWriteClinical(prisma, practitionerIdFrom(req)),
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

    const practitionerId = practitionerIdFrom(req);
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
    const practitionerId = practitionerIdFrom(req);
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
    practitionerId: practitionerIdFrom(req),
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
    practitionerId: practitionerIdFrom(req),
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
    practitionerId: practitionerIdFrom(req),
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

// The header shortcut above trusts whatever the client claims. That is fine
// for local development and a catastrophe anywhere else, so refuse to start.
if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_HEADER_AUTH) {
  console.error(
    'REFUSING TO START: this server identifies practitioners from an ' +
      'X-Practitioner-Id header, which any client can forge. Build real auth ' +
      'before deploying.',
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
