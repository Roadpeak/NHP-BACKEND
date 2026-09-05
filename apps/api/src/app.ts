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
import {
  currentSession,
  canWriteClinical,
  registerPractitioner,
  checkIn,
  checkOut,
  grantAffiliation,
  endAffiliation,
  licencesExpiringSoon,
  searchPractitioners,
} from './practitioner.js';
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
import {
  filteredRecord,
  logAccess,
  accessHistory,
  pendingBreakGlassReviews,
  reviewBreakGlass,
  breakGlassRateByFacility,
  denialAnomalies,
  ConsentError,
} from './consent.js';
import { recommend, symptomPicker, TriageError } from './triage.js';
import {
  citizenSummary,
  citizenTimeline,
  raiseDispute,
  uiStrings,
  CitizenError,
  type Lang,
} from './citizen.js';
import {
  findFacilities,
  registerFacility,
  approveFacility,
  FacilityError,
} from './facility.js';
import {
  FacilityAdminError,
  requireFacilityAdmin,
  requireFacilityScope,
  requireFacilityDirector,
  actingPersonId,
  listStaff,
  registerArrival,
  listQueue,
  closeArrival,
} from './facility-admin.js';
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
import {
  IdentityError,
  registerAdult,
  registerDependant,
  ageAt,
} from './identity.js';
import { PractitionerError } from './practitioner.js';
import { assertTestHooksEnabled, readLastSmsCode } from './testhooks.js';
import { decryptField, encryptField, blindIndex, normalisePhone } from './crypto.js';
import { encryptPhoto, decryptPhoto, PhotoError } from './photo.js';
import {
  login,
  completeMfa,
  rotateRefreshToken,
  changePassword,
  revokeAllSessions,
  verifyAccessToken,
  contextFromClaims,
  accountFromEnrolToken,
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
    // Stated explicitly. The default is GET, HEAD and POST, so a PATCH from
    // a browser fails preflight with an opaque "Failed to fetch" — and
    // `app.inject()` bypasses CORS entirely, so no server test can see it.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-csrf-token',
      'Idempotency-Key',
      'x-test-hook-secret',
    ],
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
      error instanceof PhotoError ||
      error instanceof PractitionerError ||
      error instanceof FacilityAdminError;

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
        // Administering a facility you do not administer is a refusal,
        // not a malformed request.
        'NOT_A_FACILITY_ADMIN',
        'AMBIGUOUS_FACILITY',
        'FACILITY_NOT_ACTIVE',
        'MINISTRY_GRANT_REQUIRED',
        'FACILITY_GRANT_REQUIRED',
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

  // ------------------------------------------------------------ test hooks
  //
  // Lets a contract test complete a real MFA login by reading the code the
  // console provider already printed. See testhooks.ts for why this is not
  // an MFA bypass and what it refuses.
  //
  // The route is not merely guarded but not REGISTERED in production, so a
  // misconfigured secret cannot expose an endpoint that does not exist.
  if (process.env.NODE_ENV !== 'production') {
    app.get<{ Querystring: { phone?: string } }>(
      `${v1}/test-hooks/last-sms-code`,
      async (req) => {
        assertTestHooksEnabled(req.headers['x-test-hook-secret'] as string | undefined);

        const phone = req.query.phone;
        if (!phone) {
          throw new AuthError('phone is required', 'MALFORMED_REQUEST', 400);
        }

        // Logged at warn so its use is never invisible in a shared
        // environment — an endpoint that hands out sign-in codes should be
        // noisy about every call.
        req.log.warn({ phone }, 'test hook: revealing last SMS code');

        return { code: readLastSmsCode(phone) };
      },
    );
  }

  // ----------------------------------------------------------- registration
  //
  // Open by necessity: nobody has an account yet. Each of these creates an
  // identity that can then SIGN IN — none of them grants any capability.
  //
  // In particular a practitioner leaves here with no affiliation and no
  // check-in, so they cannot touch a patient record. Who grants that
  // affiliation depends on who owns the facility, and `grantAffiliation`
  // enforces it: the Ministry posts staff to public facilities, private
  // facilities engage their own. Neither happens at registration.

  const PASSWORD_MIN = 12;

  /** Shared by every registration form. */
  const personProperties = {
    nationalId: { type: 'string', minLength: 4, maxLength: 32 },
    phone: { type: 'string', minLength: 9, maxLength: 20 },
    email: { type: 'string' },
    givenName: { type: 'string', minLength: 1, maxLength: 80 },
    middleName: { type: 'string', maxLength: 80 },
    familyName: { type: 'string', minLength: 1, maxLength: 80 },
    sexAtBirth: { type: 'string', enum: ['MALE', 'FEMALE', 'INTERSEX'] },
    dateOfBirth: { type: 'string', minLength: 10 },
    countyId: { type: 'string', minLength: 1 },
    subcountyId: { type: 'string', minLength: 1 },
    password: { type: 'string', minLength: PASSWORD_MIN },
    // Optional at registration: a passport photo helps a clinician confirm
    // they have the right patient, but refusing to register someone who has
    // no way to take one would exclude exactly the people who most need a
    // health record.
    photo: { type: 'string', maxLength: 400_000 },
  };

  const personRequired = [
    'nationalId',
    'phone',
    'givenName',
    'familyName',
    'sexAtBirth',
    'dateOfBirth',
    'countyId',
    'subcountyId',
    'password',
  ];

  interface RegisterPersonBody {
    nationalId: string;
    phone: string;
    email?: string;
    givenName: string;
    middleName?: string;
    familyName: string;
    sexAtBirth: 'MALE' | 'FEMALE' | 'INTERSEX';
    dateOfBirth: string;
    countyId: string;
    subcountyId: string;
    password: string;
    photo?: string;
  }

  /** Parses a date the form supplies, refusing anything unusable. */
  function parseDob(value: string): Date {
    const dob = new Date(value);
    if (Number.isNaN(dob.getTime())) {
      throw new IdentityError('That date of birth is not a valid date', 'INVALID_DOB');
    }
    if (dob.getTime() > Date.now()) {
      throw new IdentityError('That date of birth is in the future', 'INVALID_DOB');
    }
    return dob;
  }

  app.post<{ Body: RegisterPersonBody }>(
    `${v1}/auth/register/citizen`,
    {
      schema: {
        body: { type: 'object', required: personRequired, properties: personProperties },
      },
    },
    async (req) => {
      const b = req.body;
      const person = await registerAdult(prisma, {
        nationalId: b.nationalId,
        phone: b.phone,
        email: b.email,
        givenName: b.givenName,
        middleName: b.middleName,
        familyName: b.familyName,
        sexAtBirth: b.sexAtBirth,
        dateOfBirth: parseDob(b.dateOfBirth),
        countyId: b.countyId,
        subcountyId: b.subcountyId,
        // Hashed here and never stored or logged in the clear.
        passwordHash: await hashPassword(b.password),
      });

      if (b.photo) {
        // Validated then encrypted. `encryptPhoto` refuses anything whose
        // bytes are not really an image, so a data URL claiming to be a
        // JPEG cannot smuggle in a document.
        await prisma.person.update({
          where: { id: person.id },
          data: { photo: encryptPhoto(b.photo) },
        });
      }

      // Deliberately no session: the client signs in through the normal
      // path, so there is exactly one way to obtain a token.
      return {
        nhpId: person.displayNumber,
        message: 'Account created. Sign in to continue.',
      };
    },
  );

  app.post<{
    Body: RegisterPersonBody & {
      cadre: string;
      licenceNumber: string;
      regulator?: string;
    };
  }>(
    `${v1}/auth/register/practitioner`,
    {
      schema: {
        body: {
          type: 'object',
          required: [...personRequired, 'cadre', 'licenceNumber'],
          properties: {
            ...personProperties,
            cadre: { type: 'string', minLength: 2 },
            licenceNumber: { type: 'string', minLength: 3, maxLength: 64 },
            regulator: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const b = req.body;

      // A practitioner is a person first. The identity and the professional
      // registration are separate rows precisely so a clinician who is also
      // a patient is one human being with one record.
      const person = await registerAdult(prisma, {
        nationalId: b.nationalId,
        phone: b.phone,
        email: b.email,
        givenName: b.givenName,
        middleName: b.middleName,
        familyName: b.familyName,
        sexAtBirth: b.sexAtBirth,
        dateOfBirth: parseDob(b.dateOfBirth),
        countyId: b.countyId,
        subcountyId: b.subcountyId,
        passwordHash: await hashPassword(b.password),
      });

      if (b.photo) {
        await prisma.person.update({
          where: { id: person.id },
          data: { photo: encryptPhoto(b.photo) },
        });
      }

      const { practitioner, licence, verification } = await registerPractitioner(prisma, {
        personId: person.id,
        cadre: b.cadre as never,
        countyId: b.countyId,
        subcountyId: b.subcountyId,
        licenceNumber: b.licenceNumber,
        regulator: b.regulator as never,
        familyName: b.familyName,
      });

      // The CLINICAL account.
      //
      // `registerAdult` above created this person's own CITIZEN account on
      // the same phone. `account_one_owner_ck` allows exactly one owner per
      // account, so a clinician who is also a patient holds two — and
      // without this one they could sign in only as a patient and would
      // never reach the encounter screen at all.
      //
      // It is keyed on a derived identifier rather than the phone, because
      // the phone already belongs to the citizen account. The clinician
      // signs in with their LICENCE NUMBER, which is what they carry to
      // work and what their facility knows them by.
      const clinicalLogin = `${b.licenceNumber.trim().toUpperCase()}`;
      await prisma.account.create({
        data: {
          practitionerId: practitioner.id,
          phone: encryptField(clinicalLogin),
          phoneIndex: blindIndex(clinicalLogin, normalisePhone),
          // Their REAL number. Without this, `phone` doubles as the SMS
          // destination and a code goes to a number derived from the
          // licence — one nobody owns, so the clinician never receives it.
          smsPhone: encryptField(b.phone),
          passwordHash: await hashPassword(b.password),
          status: 'ACTIVE',
        },
      });

      return {
        nhpId: person.displayNumber,
        practitionerId: practitioner.id,
        licenceNumber: licence?.licenceNumber ?? null,
        // What they sign in with as a clinician. Said explicitly, because
        // it is NOT the phone number they just typed — that one belongs to
        // their own patient record.
        clinicalLogin,
        verification,
        // Says plainly what they still cannot do, so the UI never implies
        // a registered clinician can open a record.
        message:
          'Registration received. You cannot record clinical data until a ' +
          'facility affiliation is granted.',
        loginNote:
          'Sign in to the health workers portal with your LICENCE NUMBER, ' +
          'not your phone. Your phone signs you in to your own patient record.',
      };
    },
  );

  app.post<{
    Body: {
      mflCode: string;
      name: string;
      kephLevel: number;
      ownership: string;
      countyId: string;
      subcountyId: string;
      locality?: string;
      latitude: number;
      longitude: number;
      /**
       * How the facility itself is reached.
       *
       * Not the registrant's number — the facility's. A registrar has to
       * be able to ask about the ownership evidence before approving, and
       * a referral has to reach the place it names.
       */
      phone?: string;
      email?: string;
      businessRegNo?: string;
      kraPin?: string;
      practiceLicenceNo?: string;
      ownerNationalId?: string;
      ownerName?: string;
      adminLicenceNumber?: string;
      /**
       * The director, found rather than created.
       *
       * A hospital owner is usually a businessperson, so a clinical licence
       * cannot be the only way in — but they must already hold an account,
       * because registering an identity is not something a facility form
       * should be able to do.
       */
      directorPersonId?: string;
    };
  }>(
    `${v1}/facilities/register`,
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'mflCode',
            'name',
            'kephLevel',
            'ownership',
            'countyId',
            'subcountyId',
            'latitude',
            'longitude',
          ],
          properties: {
            mflCode: { type: 'string', minLength: 2, maxLength: 32 },
            name: { type: 'string', minLength: 2, maxLength: 160 },
            kephLevel: { type: 'integer', minimum: 2, maximum: 6 },
            ownership: { type: 'string', minLength: 2 },
            countyId: { type: 'string', minLength: 1 },
            subcountyId: { type: 'string', minLength: 1 },
            locality: { type: 'string', maxLength: 120 },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            phone: { type: 'string', maxLength: 32 },
            email: { type: 'string', maxLength: 160 },
            // Ownership evidence for a private facility. Reference numbers,
            // not scans: a registrar checks these against the Business
            // Registry, KRA and the MOH register, which is stronger than a
            // document anyone could forge and upload.
            businessRegNo: { type: 'string', maxLength: 64 },
            kraPin: { type: 'string', maxLength: 32 },
            practiceLicenceNo: { type: 'string', maxLength: 64 },
            ownerNationalId: { type: 'string', maxLength: 32 },
            ownerName: { type: 'string', maxLength: 160 },
            // The person registering a PRIVATE facility becomes its first
            // administrator, by licence number.
            adminLicenceNumber: { type: 'string', maxLength: 64 },
            directorPersonId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      const isPublic = b.ownership === 'PUBLIC_MOH' || b.ownership === 'PUBLIC_OTHER';

      // Ownership evidence is required of a PRIVATE facility and meaningless
      // for a public one, which the Ministry itself stands behind.
      if (!isPublic && !b.businessRegNo) {
        throw new FacilityError(
          'A private facility must give its business registration number, ' +
            'so the Ministry can check it against the Business Registry.',
          'OWNERSHIP_EVIDENCE_REQUIRED',
        );
      }

      const facility = await registerFacility(prisma, {
        mflCode: b.mflCode,
        name: b.name,
        kephLevel: b.kephLevel,
        ownership: b.ownership as never,
        countyId: b.countyId,
        subcountyId: b.subcountyId,
        // The service requires a locality; the form treats it as optional
        // because many dispensaries are known only by their facility name.
        locality: b.locality?.trim() || b.name,
        latitude: b.latitude,
        longitude: b.longitude,
        phone: b.phone?.trim() || undefined,
        email: b.email?.trim() || undefined,
      });

      if (!isPublic) {
        await prisma.facility.update({
          where: { id: facility.id },
          data: {
            businessRegNo: b.businessRegNo,
            kraPin: b.kraPin ?? null,
            practiceLicenceNo: b.practiceLicenceNo ?? null,
            // Encrypted, like every other National ID in the system.
            ownerNationalId: b.ownerNationalId ? encryptField(b.ownerNationalId) : null,
            ownerName: b.ownerName ?? null,
          },
        });
      }

      /*
       * The first administrator.
       *
       * For a PRIVATE facility this is whoever registered it, named by
       * licence number — they supplied the ownership evidence and the
       * Ministry checks it before approving. The affiliation is created
       * now but the facility is PENDING, so it confers nothing until a
       * registrar has verified who they are.
       */
      /*
       * The director, however they identified themselves.
       *
       * A hospital owner is usually a businessperson, so requiring a
       * clinical licence to register a facility you own excluded the people
       * who actually own most private hospitals in Kenya. Three ways in, and
       * exactly one may be used:
       *
       *   - a new person, who sets their own password here;
       *   - an existing person, found by the director search;
       *   - a licence, for a clinician-owner, which also keeps the
       *     FACILITY_ADMIN affiliation the previous design created.
       *
       * Both are recorded as PENDING. Nobody administers a facility the
       * Ministry has not verified, which is the rule approval enforces.
       *
       * Creating an account HERE is deliberately not one of the ways.
       * Somebody registering a facility already has an identity in this
       * country's health system, or should get one the same way everybody
       * else does — through the citizen or health worker portal, where the
       * identity checks live. A second registration path would be a second
       * place for those checks to be weaker.
       */
      const ways = [
        b.directorPersonId ? 'existing' : null,
        b.adminLicenceNumber ? 'licence' : null,
      ].filter(Boolean);
      if (ways.length > 1) {
        throw new FacilityError(
          'Name the director once: as an existing account or a licence ' +
            'number — not both.',
          'AMBIGUOUS_DIRECTOR',
        );
      }

      let directorPersonId: string | null = null;

      if (b.directorPersonId) {
        const person = await prisma.person.findUnique({
          where: { id: b.directorPersonId },
          select: { id: true },
        });
        if (!person) {
          throw new FacilityError('That person was not found.', 'DIRECTOR_NOT_FOUND');
        }
        directorPersonId = person.id;
      }

      let firstAdmin: string | null = null;
      if (!isPublic && b.adminLicenceNumber) {
        const licence = await prisma.licence.findFirst({
          where: { licenceNumber: b.adminLicenceNumber.trim().toUpperCase() },
          select: { practitionerId: true },
        });
        if (!licence) {
          throw new FacilityError(
            `No practitioner holds licence ${b.adminLicenceNumber}. Register ` +
              'as a health worker first, then register the facility.',
            'ADMIN_LICENCE_NOT_FOUND',
          );
        }
        // Recorded as an intent, not an affiliation. `approveFacility`
        // turns it into a real FACILITY_ADMIN once a registrar has checked
        // the ownership evidence against national records.
        await prisma.facility.update({
          where: { id: facility.id },
          data: { pendingAdminPractitionerId: licence.practitionerId },
        });
        firstAdmin = licence.practitionerId;

        // A clinician-owner is also a director. Linking the Person behind
        // their practitioner record keeps one human as one identity, rather
        // than two half-accounts that drift apart.
        const prac = await prisma.practitioner.findUnique({
          where: { id: licence.practitionerId },
          select: { personId: true },
        });
        directorPersonId = prac?.personId ?? null;
      }

      if (directorPersonId) {
        await prisma.facility.update({
          where: { id: facility.id },
          data: { pendingDirectorPersonId: directorPersonId },
        });
      }

      // PENDING until a Ministry registrar approves it. An unapproved
      // facility can grant no affiliation and host no check-in, so it
      // cannot reach a patient record.
      return {
        facilityId: facility.id,
        mflCode: facility.mflCode,
        registrationStatus: facility.registrationStatus,
        firstAdminPractitionerId: firstAdmin,
        message: isPublic
          ? 'Facility registered and awaiting Ministry approval. The Ministry ' +
            'posts staff to public facilities.'
          : 'Facility registered and awaiting Ministry approval. Your ' +
            'ownership details will be checked against national records. ' +
            'Staff cannot be added until it is approved.',
      };
    },
  );

  /**
   * A person's photo.
   *
   * Behind the same authorisation as the record it belongs to: a clinician
   * with an open check-in, or the citizen themselves. Never a public URL —
   * a face plus a name outside every guard the system has is precisely what
   * the encryption exists to prevent.
   */
  app.get<{ Params: { nhpId: string } }>(`${v1}/persons/:nhpId/photo`, async (req) => {
    await practitionerFrom(req);
    const personId = await resolvePersonId(prisma, req.params.nhpId);
    const person = await prisma.person.findUnique({
      where: { id: personId },
      select: { photo: true },
    });
    return { photo: decryptPhoto(person?.photo ?? null) };
  });

  app.get(`${v1}/persons/me/photo`, async (req) => {
    const ctx = await contextFrom(req);
    // `requireSelf(ctx, ctx.personId)` would compare a value to itself and
    // pass for anyone — including a practitioner whose personId is absent,
    // where empty equals empty. The account KIND is what to check here.
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }
    const person = await prisma.person.findUnique({
      where: { id: ctx.personId },
      select: { photo: true },
    });
    return { photo: decryptPhoto(person?.photo ?? null) };
  });

  /** A citizen replacing their own photo. */
  app.post<{ Body: { photo: string } }>(
    `${v1}/persons/me/photo`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['photo'],
          properties: { photo: { type: 'string', maxLength: 400_000 } },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      if (!ctx.personId) {
        throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
      }
      // Their own record only: the id comes from the token, never the body,
      // so there is no parameter to tamper with.
      await prisma.person.update({
        where: { id: ctx.personId },
        data: { photo: encryptPhoto(req.body.photo) },
      });
      return { updated: true };
    },
  );

  // -------------------------------------------------------- geography (open)
  //
  // Registration forms need counties and subcounties before anyone has an
  // account, so these cannot sit behind the Ministry guard the way
  // /analytics/counties does. They are the published administrative
  // divisions of Kenya — public record, not patient data.

  app.get(`${v1}/geo/counties`, async () =>
    prisma.county.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  );

  app.get<{ Params: { countyId: string } }>(
    `${v1}/geo/counties/:countyId/subcounties`,
    async (req) =>
      prisma.subCounty.findMany({
        where: { countyId: req.params.countyId },
        select: { id: true, name: true, kind: true },
        orderBy: { name: 'asc' },
      }),
  );

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

  /**
   * Whoever is running a facility, clinician or not.
   *
   * A hospital owner is usually a businessperson, so the person
   * administering a facility often holds no licence at all. Routes should
   * not have to care: the roster is the roster and the reception queue is
   * the reception queue either way.
   *
   * The second factor is still demanded of both. This is the administrative
   * surface of a facility that reaches patient names, so a session that
   * never presented its second factor must not open it.
   */
  async function facilityScopeFrom(
    req: { headers: Record<string, unknown> },
    facilityId?: string,
    /**
     * Whether this route is administration.
     *
     * Defaults to true because most of the facility portal is: the roster,
     * the facility record, the list of directors. Only the waiting room is
     * not, and it passes false. Refusing here rather than in the UI means a
     * receptionist who types the URL is refused too.
     */
    requireAdmin = true,
  ) {
    const ctx = await contextFrom(req);
    if (!ctx.mfa) {
      throw new AuthError(
        'Your second factor has not been presented in this session',
        'MFA_REQUIRED',
        403,
      );
    }
    const scope = await requireFacilityScope(
      prisma,
      { practitionerId: ctx.practitionerId, personId: ctx.personId },
      facilityId,
    );

    if (requireAdmin && !scope.canAdminister) {
      throw new FacilityAdminError(
        'Reception can register arrivals and see the waiting room. The staff ' +
          'roster, the facility record and its directors are for whoever runs ' +
          'the facility.',
        'NOT_A_FACILITY_ADMIN',
      );
    }
    return scope;
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

  /**
   * Change your own password.
   *
   * Needed because a facility owner currently issues the first password
   * for their reception staff: without this, that staff member could never
   * stop using a credential their employer knows.
   */
  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    `${v1}/auth/password`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 256 },
            newPassword: { type: 'string', minLength: 10, maxLength: 256 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      return changePassword(prisma, ctx.accountId, req.body);
    },
  );

  app.get(`${v1}/auth/me`, async (req) => {
    const ctx = await contextFrom(req);
    const session = ctx.practitionerId
      ? await currentSession(prisma, ctx.practitionerId)
      : null;

    /*
     * Who this clinician IS, for the attribution line on the encounter
     * screen. A footer that names the wrong person — or a fixed demo name —
     * signs a record to somebody who never saw the patient.
     */
    const practitioner = ctx.practitionerId
      ? await prisma.practitioner.findUnique({
          where: { id: ctx.practitionerId },
          select: {
            cadre: true,
            person: { select: { givenName: true, familyName: true } },
            licences: {
              where: { status: 'ACTIVE' },
              select: { licenceNumber: true },
              orderBy: { expiresOn: 'desc' },
              take: 1,
            },
          },
        })
      : null;

    /*
     * Whether they administer a facility.
     *
     * A facility administrator IS a practitioner — that is what keeps the
     * licence checks and audit trail applying to them — but the two
     * portals are different places, and without this the sign-in form
     * could not tell them apart and sent every administrator to the
     * clinical portal.
     */
    /*
     * A directorship, for someone who runs a facility without a licence.
     *
     * Kept beside `adminOf` rather than folded into it: the two are
     * genuinely different facts, and a screen that needs to know whether
     * the person can also treat patients must be able to tell them apart.
     */
    // The flag lives on the account, not the token: a password changed in
    // another tab must stop prompting here without a fresh sign-in.
    const account = await prisma.account.findUnique({
      where: { id: ctx.accountId },
      select: { mustChangePassword: true },
    });

    // Either session resolves to the same human: a clinician's licence
    // account carries no personId, so a directorship hangs off a Person the
    // clinical token never mentions.
    const actingPerson = await actingPersonId(prisma, {
      practitionerId: ctx.practitionerId,
      personId: ctx.personId,
    });

    const directorOf = actingPerson
      ? await prisma.facilityDirector.findFirst({
          where: {
            personId: actingPerson,
            status: 'ACTIVE',
            endedAt: null,
            facility: { registrationStatus: 'ACTIVE' },
          },
          select: { facilityId: true, role: true, facility: { select: { name: true } } },
        })
      : null;

    const adminOf = ctx.practitionerId
      ? await prisma.affiliation.findFirst({
          where: {
            practitionerId: ctx.practitionerId,
            role: 'FACILITY_ADMIN',
            status: 'ACTIVE',
            endedAt: null,
            facility: { registrationStatus: 'ACTIVE' },
          },
          select: { facilityId: true, facility: { select: { name: true } } },
        })
      : null;

    return {
      displayName: practitioner
        ? `${decryptField(practitioner.person.givenName)} ` +
          `${decryptField(practitioner.person.familyName)}`
        : null,
      cadre: practitioner?.cadre ?? null,
      licenceNumber: practitioner?.licences[0]?.licenceNumber ?? null,
      accountId: ctx.accountId,
      practitionerId: ctx.practitionerId ?? null,
      ministryUserId: ctx.ministryUserId ?? null,
      // The admin portal shows different sections per role, so it must be
      // able to read the role without a second call. Authorisation is still
      // the server's: this only tells the UI what not to bother rendering.
      ministryRole: ctx.ministryRole ?? null,
      geoScope: ctx.geoScope ?? null,
      scopeCountyId: ctx.scopeCountyId ?? null,
      personId: ctx.personId ?? null,
      mfaSatisfied: ctx.mfa,
      checkedInAt: session?.facility.name ?? null,
      // Either route into the facility portal answers the same question:
      // does this account run a facility? A director with no licence must
      // resolve here or they land on the citizen portal.
      facilityAdminOf: adminOf?.facilityId ?? directorOf?.facilityId ?? null,
      facilityAdminOfName: adminOf?.facility.name ?? directorOf?.facility.name ?? null,
      facilityDirectorOf: directorOf?.facilityId ?? null,
      facilityDirectorRole: directorOf?.role ?? null,
      /*
       * Whether they may see anything beyond the waiting room.
       *
       * Sent so the portal can render the nav a reception account can
       * actually use, rather than showing tabs that will refuse them. The
       * refusal still lives on the server — this only stops the UI lying.
       */
      // So the portal can insist on a change before the account is used
      // in earnest. The server does not block on it: locking somebody out
      // of a screen they were just given access to is worse than a
      // prominent prompt, and the flag is what makes it visible either way.
      mustChangePassword: account?.mustChangePassword ?? false,
      canAdministerFacility: adminOf
        ? true
        : directorOf
          ? directorOf.role !== 'RECEPTION'
          : false,
    };
  });

  /**
   * Whose account is enrolling.
   *
   * Accepts EITHER a normal session (someone adding or changing a factor
   * while already signed in) OR an enrolment token (someone who cannot
   * sign in yet because they have no factor at all). Without the second
   * case a newly registered clinician is locked out permanently: every
   * enrolment route needs a session, and they cannot obtain one.
   *
   * The enrolment token is checked on its own audience, so it unlocks
   * nothing but these four routes.
   */
  async function enrollingAccount(req: {
    headers: Record<string, unknown>;
    body?: unknown;
  }): Promise<string> {
    const enrolToken = (req.body as { enrolToken?: string } | undefined)?.enrolToken;
    if (enrolToken) return accountFromEnrolToken(enrolToken);
    const ctx = await contextFrom(req as never);
    return ctx.accountId;
  }

  app.post<{ Body: { label?: string; enrolToken?: string } }>(
    `${v1}/auth/mfa/enrol`,
    async (req) => {
      const accountId = await enrollingAccount(req);
      return enrolTotp(prisma, accountId, req.body?.label ?? 'NHP account');
    },
  );

  app.post<{ Body: { code: string; enrolToken?: string } }>(
    `${v1}/auth/mfa/confirm`,
    async (req) => {
      const accountId = await enrollingAccount(req);
      return confirmTotp(prisma, accountId, req.body.code);
    },
  );

  /**
   * SMS second factor.
   *
   * The primary channel for Kenya: authenticator apps assume a smartphone,
   * and a clinical officer on a feature phone has none.
   */
  app.post<{ Body: { enrolToken?: string } }>(
    `${v1}/auth/mfa/sms/enrol`,
    async (req) => {
      const accountId = await enrollingAccount(req);
      return enrolSms(prisma, accountId);
    },
  );

  app.post<{ Body: { code: string; enrolToken?: string } }>(
    `${v1}/auth/mfa/sms/confirm`,
    async (req) => {
      const accountId = await enrollingAccount(req);
      return confirmSms(prisma, accountId, req.body.code);
    },
  );

  /** Resend a login code. No session yet, so the mfaToken is the credential. */
  app.post<{ Body: { mfaToken: string } }>(`${v1}/auth/mfa/resend`, async (req) =>
    resendMfaCode(prisma, req.body.mfaToken),
  );

  /**
   * The facilities this clinician may check in to.
   *
   * Their affiliations, which is the whole basis of the check-in gate: a
   * clinician can only work where someone authorised them to. Returned so
   * the portal can offer a choice rather than making them type an id.
   */
  // ------------------------------------------------------- facility portal

  /**
   * The facility an administrator runs.
   *
   * Every route below re-derives the scope from the caller's own
   * affiliations rather than trusting a facility id in the request. An
   * administrator of one facility asking about another gets
   * NOT_A_FACILITY_ADMIN, not somebody else's roster.
   */
  app.get(`${v1}/facility/me`, async (req) => {
    const scope = await facilityScopeFrom(req);
    const facility = await prisma.facility.findUniqueOrThrow({
      where: { id: scope.facilityId },
      select: {
        id: true,
        mflCode: true,
        name: true,
        kephLevel: true,
        ownership: true,
        registrationStatus: true,
        locality: true,
        approvedAt: true,
        businessRegNo: true,
        kraPin: true,
        practiceLicenceNo: true,
        ownerName: true,
        county: { select: { name: true } },
        subcounty: { select: { name: true } },
      },
    });
    return {
      ...facility,
      countyName: facility.county.name,
      subcountyName: facility.subcounty.name,
      county: undefined,
      subcounty: undefined,
      isPublic: scope.isPublic,
      // The ownership rule, stated to the portal so it can explain itself
      // rather than surprising an administrator with a refusal.
      staffingRule: scope.isPublic
        ? 'The Ministry posts staff to public facilities. You cannot add staff here.'
        : 'You engage your own staff. Add them by licence number below.',
    };
  });

  app.get<{ Querystring: { includeEnded?: string } }>(`${v1}/facility/staff`, async (req) => {
    const scope = await facilityScopeFrom(req);
    return {
      facilityName: scope.facilityName,
      isPublic: scope.isPublic,
      staff: await listStaff(prisma, scope.facilityId, {
        includeEnded: req.query?.includeEnded === 'true',
      }),
    };
  });

  app.post<{
    Body: { licenceNumber: string; role?: string };
  }>(
    `${v1}/facility/staff`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['licenceNumber'],
          properties: {
            licenceNumber: { type: 'string', minLength: 1, maxLength: 64 },
            role: {
              type: 'string',
              enum: ['ATTENDING', 'RESIDENT', 'VISITING', 'LOCUM', 'FACILITY_ADMIN'],
            },
          },
        },
      },
    },
    async (req) => {
      const scope = await facilityScopeFrom(req);

      const licence = await prisma.licence.findFirst({
        where: { licenceNumber: req.body.licenceNumber.trim().toUpperCase() },
        select: {
          practitionerId: true,
          status: true,
          practitioner: {
            select: {
              cadre: true,
              person: { select: { givenName: true, familyName: true } },
            },
          },
        },
      });
      if (!licence) {
        throw new FacilityAdminError(
          `No practitioner holds licence ${req.body.licenceNumber}. They must ` +
            'register on the health worker portal first.',
          'LICENCE_NOT_FOUND',
        );
      }

      // `grantAffiliation` enforces the ownership rule: naming the actor
      // as FACILITY here is what makes it refuse on a public facility,
      // where only the Ministry may post staff.
      const affiliation = await grantAffiliation(prisma, {
        practitionerId: licence.practitionerId,
        facilityId: scope.facilityId,
        role: (req.body.role ?? 'ATTENDING') as never,
        grantedBy: scope.actorPractitionerId ?? scope.actorPersonId!,
        grantedByKind: 'FACILITY',
      });

      return {
        affiliationId: affiliation.id,
        practitionerId: licence.practitionerId,
        displayName: `${licence.practitioner.person.givenName} ${licence.practitioner.person.familyName}`,
        cadre: licence.practitioner.cadre,
        licenceStatus: licence.status,
      };
    },
  );

  /**
   * The people who RUN the facility, as opposed to the clinicians who work
   * in it.
   *
   * A facility with one director stops working the day that person leaves,
   * which is the real problem a shared facility password appears to solve
   * — and solves badly, because a shared credential cannot be revoked for
   * one person and makes every action attributable to a building rather
   * than a human. Naming a second director solves it properly: the clinic
   * keeps running, and every action still has somebody's name on it.
   */
  app.get(`${v1}/facility/directors`, async (req) => {
    const scope = await facilityScopeFrom(req);
    const rows = await prisma.facilityDirector.findMany({
      where: { facilityId: scope.facilityId, endedAt: null },
      select: {
        id: true,
        role: true,
        status: true,
        startedAt: true,
        appointedByKind: true,
        person: { select: { id: true, givenName: true, familyName: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
    return {
      facilityName: scope.facilityName,
      directors: rows.map((d) => ({
        id: d.id,
        personId: d.person.id,
        displayName: `${decryptField(d.person.givenName)} ${decryptField(d.person.familyName)}`,
        role: d.role,
        status: d.status,
        startedAt: d.startedAt,
        appointedByKind: d.appointedByKind,
        // So the caller can tell which row is theirs without a second
        // request, and so "you cannot remove yourself" is explicable.
        isYou: d.person.id === scope.actorPersonId,
      })),
    };
  });

  /**
   * Appoint another director.
   *
   * By National ID or licence number, resolved through the same search the
   * registration form uses — the person must already have an account, so
   * this creates no credential and hands out no password.
   */
  app.post<{ Body: { identifier: string; role?: string } }>(
    `${v1}/facility/directors`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['identifier'],
          properties: {
            identifier: { type: 'string', minLength: 6, maxLength: 64 },
            role: { type: 'string', enum: ['OWNER', 'DIRECTOR', 'MANAGER'] },
          },
        },
      },
    },
    async (req) => {
      const scope = await facilityScopeFrom(req);
      const identifier = req.body.identifier.trim();

      const licence = await prisma.licence.findFirst({
        where: { licenceNumber: identifier.toUpperCase() },
        select: { practitioner: { select: { personId: true } } },
      });
      let personId = licence?.practitioner?.personId ?? null;

      // An NHP number, which is what a citizen carries and the only one of
      // the three they can read off their own record.
      if (!personId && /^NHP-/i.test(identifier)) {
        const byNhp = await prisma.person.findUnique({
          where: { displayNumber: identifier.toUpperCase() },
          select: { id: true },
        });
        personId = byNhp?.id ?? null;
      }
      if (!personId) {
        const match = await prisma.identifier.findFirst({
          where: {
            type: 'NATIONAL_ID',
            valueIndex: blindIndex(identifier),
            status: 'ACTIVE',
          },
          select: { personId: true },
        });
        personId = match?.personId ?? null;
      }
      if (!personId) {
        throw new FacilityAdminError(
          'Nobody with that National ID or licence number has an account. They ' +
            'must register first — a director signs in as themselves.',
          'DIRECTOR_NOT_FOUND',
        );
      }

      const person = await prisma.person.findUniqueOrThrow({
        where: { id: personId },
        select: { givenName: true, familyName: true },
      });

      // ACTIVE immediately: an existing director vouching for another is
      // the facility's own decision, and the Ministry already verified the
      // facility itself. Re-appointing someone who left reinstates them
      // rather than failing on the unique pair.
      const director = await prisma.facilityDirector.upsert({
        where: { facilityId_personId: { facilityId: scope.facilityId, personId } },
        create: {
          facilityId: scope.facilityId,
          personId,
          role: (req.body.role ?? 'DIRECTOR') as never,
          status: 'ACTIVE',
          appointedBy: scope.actorPersonId ?? scope.actorPractitionerId ?? 'facility',
          appointedByKind: 'SELF',
        },
        update: { status: 'ACTIVE', endedAt: null },
      });

      req.log.info(
        { facilityId: scope.facilityId, personId },
        'facility appointed a director',
      );
      return {
        id: director.id,
        personId,
        displayName: `${decryptField(person.givenName)} ${decryptField(person.familyName)}`,
        role: director.role,
        status: director.status,
      };
    },
  );

  /**
   * The people who work the reception desk.
   *
   * Staff are Persons, like directors, and reach the facility through the
   * same table with a RECEPTION role. They see the waiting room and nothing
   * else — the guard refuses them the roster, the facility record and the
   * directors list, so a receptionist who types the URL is refused too.
   */
  app.get(`${v1}/facility/staff-accounts`, async (req) => {
    const scope = await facilityScopeFrom(req);
    const rows = await prisma.facilityDirector.findMany({
      where: { facilityId: scope.facilityId, role: 'RECEPTION', endedAt: null },
      select: {
        id: true,
        status: true,
        startedAt: true,
        person: { select: { id: true, givenName: true, familyName: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
    const accounts = await prisma.account.findMany({
      where: { personId: { in: rows.map((r) => r.person.id) } },
      select: { personId: true, mustChangePassword: true },
    });
    const pending = new Map(accounts.map((a) => [a.personId, a.mustChangePassword]));

    return {
      facilityName: scope.facilityName,
      staff: rows.map((r) => ({
        id: r.id,
        personId: r.person.id,
        displayName: `${decryptField(r.person.givenName)} ${decryptField(r.person.familyName)}`,
        status: r.status,
        startedAt: r.startedAt,
        // Surfaced so the owner can see who is still using the password
        // they were handed — the state this stopgap must not leave behind.
        mustChangePassword: pending.get(r.person.id) ?? false,
      })),
    };
  });

  /**
   * Add a receptionist.
   *
   * TEMPORARY: the owner chooses the first password, so the employer knows
   * it and anything done on that account is deniable until it is changed.
   * This is accepted for a pre-launch system holding no real patient data,
   * and `mustChangePassword` marks every account issued this way. When
   * email is available, only this credential step changes — an invite token
   * instead of an owner-chosen password. Nothing else here moves.
   */
  app.post<{
    Body: { nationalId: string; name: string; phone: string; password?: string };
  }>(
    `${v1}/facility/staff-accounts`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['nationalId', 'name', 'phone'],
          properties: {
            nationalId: { type: 'string', minLength: 4, maxLength: 32 },
            name: { type: 'string', minLength: 2, maxLength: 160 },
            phone: { type: 'string', minLength: 6, maxLength: 32 },
            password: { type: 'string', minLength: 10, maxLength: 256 },
          },
        },
      },
    },
    async (req) => {
      const scope = await facilityScopeFrom(req);
      const b = req.body;

      /*
       * Somebody already registered keeps their own password.
       *
       * Without this, an owner who knows any citizen's National ID could
       * overwrite that person's password and take their account — a way in
       * to somebody's health record, granted by a staff form. Existing
       * people gain the role and nothing else.
       */
      const existing = await prisma.identifier.findFirst({
        where: {
          type: 'NATIONAL_ID',
          valueIndex: blindIndex(b.nationalId.trim()),
          status: 'ACTIVE',
        },
        select: { personId: true },
      });

      let personId: string;
      if (existing) {
        personId = existing.personId;
      } else {
        if (!b.password) {
          throw new FacilityAdminError(
            'Nobody with that National ID is registered yet, so give them a ' +
              'first password. They should change it once they sign in.',
            'STAFF_PASSWORD_REQUIRED',
          );
        }
        const [given, ...rest] = b.name.trim().split(/\s+/);
        const person = await registerAdult(prisma, {
          nationalId: b.nationalId.trim(),
          phone: b.phone.trim(),
          givenName: given,
          familyName: rest.join(' ') || given,
          sexAtBirth: 'FEMALE',
          dateOfBirth: new Date('1990-01-01'),
          countyId: (await prisma.facility.findUniqueOrThrow({
            where: { id: scope.facilityId },
            select: { countyId: true },
          })).countyId,
          subcountyId: (await prisma.facility.findUniqueOrThrow({
            where: { id: scope.facilityId },
            select: { subcountyId: true },
          })).subcountyId,
          passwordHash: await hashPassword(b.password),
        });
        personId = person.id;
        await prisma.account.updateMany({
          where: { personId },
          data: { mustChangePassword: true },
        });
      }

      const staff = await prisma.facilityDirector.upsert({
        where: { facilityId_personId: { facilityId: scope.facilityId, personId } },
        create: {
          facilityId: scope.facilityId,
          personId,
          role: 'RECEPTION',
          status: 'ACTIVE',
          appointedBy: scope.actorPersonId ?? scope.actorPractitionerId ?? 'facility',
          appointedByKind: 'SELF',
        },
        update: { status: 'ACTIVE', endedAt: null, role: 'RECEPTION' },
      });

      const person = await prisma.person.findUniqueOrThrow({
        where: { id: personId },
        select: { givenName: true, familyName: true },
      });
      req.log.info({ facilityId: scope.facilityId, personId }, 'facility added reception staff');
      return {
        id: staff.id,
        personId,
        displayName: `${decryptField(person.givenName)} ${decryptField(person.familyName)}`,
        status: staff.status,
        // Says plainly when nothing was issued, so the owner does not go
        // looking for a password to hand over.
        credentialIssued: !existing,
      };
    },
  );

  /** Remove a receptionist. */
  app.delete<{ Params: { staffId: string } }>(
    `${v1}/facility/staff-accounts/:staffId`,
    async (req) => {
      const scope = await facilityScopeFrom(req);
      const staff = await prisma.facilityDirector.findUnique({
        where: { id: req.params.staffId },
        select: { id: true, facilityId: true, role: true },
      });
      if (!staff || staff.facilityId !== scope.facilityId || staff.role !== 'RECEPTION') {
        throw new FacilityAdminError('Staff member not found', 'STAFF_NOT_FOUND');
      }
      await prisma.facilityDirector.update({
        where: { id: staff.id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      return { ended: true };
    },
  );

  /** End a directorship. */
  app.delete<{ Params: { directorId: string } }>(
    `${v1}/facility/directors/:directorId`,
    async (req) => {
      const scope = await facilityScopeFrom(req);

      const director = await prisma.facilityDirector.findUnique({
        where: { id: req.params.directorId },
        select: { id: true, facilityId: true, personId: true },
      });
      if (!director || director.facilityId !== scope.facilityId) {
        throw new FacilityAdminError('Director not found', 'DIRECTOR_NOT_FOUND');
      }

      // Removing yourself leaves nobody able to undo it, and removing the
      // last one leaves a facility nobody can administer — the exact state
      // this whole feature exists to prevent.
      if (scope.actorPersonId && director.personId === scope.actorPersonId) {
        throw new FacilityAdminError(
          'You cannot remove your own access. Appoint another director first, ' +
            'and ask them to remove you.',
          'CANNOT_REMOVE_SELF',
        );
      }

      const remaining = await prisma.facilityDirector.count({
        where: { facilityId: scope.facilityId, status: 'ACTIVE', endedAt: null },
      });
      if (remaining <= 1) {
        throw new FacilityAdminError(
          'A facility must always have a director. Appoint another one first.',
          'LAST_DIRECTOR',
        );
      }

      await prisma.facilityDirector.update({
        where: { id: director.id },
        data: { status: 'ENDED', endedAt: new Date() },
      });
      return { ended: true };
    },
  );

  app.delete<{ Params: { affiliationId: string } }>(
    `${v1}/facility/staff/:affiliationId`,
    async (req) => {
      const scope = await facilityScopeFrom(req);

      const affiliation = await prisma.affiliation.findUnique({
        where: { id: req.params.affiliationId },
        select: { id: true, facilityId: true, practitionerId: true },
      });
      // Same answer whether it belongs to another facility or does not
      // exist: an administrator does not get to probe other rosters.
      if (!affiliation || affiliation.facilityId !== scope.facilityId) {
        throw new FacilityAdminError('Affiliation not found', 'AFFILIATION_NOT_FOUND');
      }
      if (
        scope.actorPractitionerId &&
        affiliation.practitionerId === scope.actorPractitionerId
      ) {
        throw new FacilityAdminError(
          'You cannot remove your own administrator access. Ask the Ministry, ' +
            'or appoint another administrator first.',
          'CANNOT_REMOVE_SELF',
        );
      }

      await endAffiliation(prisma, affiliation.id);
      return { ended: true };
    },
  );

  // --------------------------------------------------------- reception desk

  /**
   * The waiting room.
   *
   * Open to any active affiliate of the facility, not only the
   * administrator: reception staff work these routes all day, and at a
   * small dispensary the clinician works the desk themselves. What keeps
   * reception out of clinical data is not this gate — it is that they
   * hold no licence, and `canWriteClinical` refuses without one.
   */
  async function receptionScope(req: { headers: Record<string, unknown> }) {
    const ctx = await contextFrom(req);
    if (!ctx.mfa) {
      throw new AuthError(
        'Your second factor has not been presented in this session',
        'MFA_REQUIRED',
        403,
      );
    }

    /*
     * A director has exactly one desk.
     *
     * The ambiguity this function exists to resolve is a clinician's: they
     * work at several facilities and the queue must not guess which. A
     * director runs one facility, so there is nothing to disambiguate —
     * and requiring a licence here was what left an owner staring at
     * "this endpoint requires a clinical account" on their own reception
     * desk.
     */
    const directorPerson = ctx.practitionerId
      ? null
      : await actingPersonId(prisma, { personId: ctx.personId });
    if (directorPerson) {
      const scope = await requireFacilityDirector(prisma, directorPerson);
      return {
        facilityId: scope.facilityId,
        facilityName: scope.facilityName,
        // The column records WHO registered the arrival, and a director is
        // a legitimate who. It is not a licence claim — arrivals are
        // administrative, which is the whole reason reception can write
        // them at all.
        practitionerId: directorPerson,
      };
    }

    const practitionerId = requirePractitioner(ctx);

    /*
     * WHICH desk this is.
     *
     * A clinician commonly works at more than one facility — a county
     * referral and a private clinic on alternate days. Picking whichever
     * affiliation the database returned first put arrivals into the wrong
     * waiting room, and showed a queue belonging to a different building.
     *
     * Resolved in this order:
     *   1. an open check-in — they are physically at that facility now;
     *   2. the facility they administer;
     *   3. their single affiliation, if they have only one.
     *
     * With none of those, it refuses and asks rather than guessing.
     */
    const open = await prisma.checkIn.findFirst({
      where: { practitionerId, endedAt: null, expiresAt: { gt: new Date() } },
      select: { facilityId: true, facility: { select: { name: true } } },
    });

    const admin = open
      ? null
      : await prisma.affiliation.findFirst({
          where: {
            practitionerId,
            role: 'FACILITY_ADMIN',
            status: 'ACTIVE',
            endedAt: null,
            facility: { registrationStatus: 'ACTIVE' },
          },
          select: { facilityId: true, facility: { select: { name: true } } },
        });

    let affiliation = open ?? admin;

    if (!affiliation) {
      const all = await prisma.affiliation.findMany({
        where: { practitionerId, status: 'ACTIVE', endedAt: null },
        select: { facilityId: true, facility: { select: { name: true } } },
        take: 2,
      });
      if (all.length === 1) affiliation = all[0];
      else if (all.length > 1) {
        throw new FacilityAdminError(
          'You work at more than one facility. Check in to the one you are ' +
            'at before registering arrivals, so they join the right queue.',
          'AMBIGUOUS_FACILITY',
        );
      }
    }

    if (!affiliation) {
      throw new FacilityAdminError(
        'You are not affiliated to a facility, so you cannot register arrivals.',
        'NOT_A_FACILITY_ADMIN',
      );
    }
    return {
      practitionerId,
      facilityId: affiliation.facilityId,
      facilityName: affiliation.facility.name,
    };
  }

  app.get(`${v1}/facility/queue`, async (req) => {
    const scope = await receptionScope(req);
    return {
      facilityName: scope.facilityName,
      queue: await listQueue(prisma, scope.facilityId),
    };
  });

  app.post<{ Body: { nhpId: string; statedReason?: string } }>(
    `${v1}/facility/queue`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['nhpId'],
          properties: {
            nhpId: { type: 'string', minLength: 1, maxLength: 32 },
            statedReason: { type: 'string', maxLength: 280 },
          },
        },
      },
    },
    async (req) => {
      const scope = await receptionScope(req);
      return registerArrival(prisma, {
        facilityId: scope.facilityId,
        nhpId: req.body.nhpId,
        statedReason: req.body.statedReason,
        registeredBy: scope.practitionerId,
      });
    },
  );

  app.patch<{ Params: { arrivalId: string }; Body: { status: 'LEFT' | 'COMPLETED' } }>(
    `${v1}/facility/queue/:arrivalId`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: { status: { type: 'string', enum: ['LEFT', 'COMPLETED'] } },
        },
      },
    },
    async (req) => {
      const scope = await receptionScope(req);
      return closeArrival(prisma, req.params.arrivalId, scope.facilityId, req.body.status);
    },
  );

  app.get(`${v1}/check-ins/facilities`, async (req) => {
    const practitionerId = await practitionerFrom(req);
    const affiliations = await prisma.affiliation.findMany({
      where: { practitionerId, status: 'ACTIVE' },
      select: {
        id: true,
        role: true,
        facility: {
          select: {
            id: true,
            name: true,
            mflCode: true,
            kephLevel: true,
            countyId: true,
            registrationStatus: true,
          },
        },
      },
    });

    return affiliations
      // An unapproved facility can host no check-in, so offering it would
      // be offering a refusal.
      .filter((a) => a.facility.registrationStatus === 'ACTIVE')
      .map((a) => ({
        affiliationId: a.id,
        role: a.role,
        facilityId: a.facility.id,
        name: a.facility.name,
        mflCode: a.facility.mflCode,
        kephLevel: a.facility.kephLevel,
        countyId: a.facility.countyId,
      }));
  });

  /**
   * Starting a shift.
   *
   * The check-in is what makes a clinical write attributable to a place as
   * well as a person, and `checkIn` refuses without an active affiliation
   * and licence. Exposing it here is what lets a clinician actually begin
   * work — until now the service existed and nothing could call it.
   */
  app.post<{ Body: { facilityId: string } }>(
    `${v1}/check-ins`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['facilityId'],
          properties: { facilityId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req) => {
      const practitionerId = await practitionerFrom(req);
      const { session, licenceNumber } = await checkIn(prisma, {
        practitionerId,
        facilityId: req.body.facilityId,
      });
      return {
        id: session.id,
        facilityId: session.facilityId,
        expiresAt: session.expiresAt,
        // Stamped on every clinical row written during this session, so a
        // record carries which licence was current at the time.
        licenceNumber,
      };
    },
  );

  /** Ending a shift. */
  app.post(`${v1}/check-ins/end`, async (req) => {
    const practitionerId = await practitionerFrom(req);
    try {
      await checkOut(prisma, practitionerId);
      return { ended: true };
    } catch (err) {
      // `checkOut` throws NO_OPEN_SESSION, which the error handler renders
      // as a 403. A clinician who was already checked out is not being
      // refused anything — they are in the state they asked for, and a
      // permission error at the end of a shift reads as a fault.
      if (err instanceof PractitionerError && err.code === 'NO_OPEN_SESSION') {
        return { ended: false };
      }
      throw err;
    }
  });

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
    requireMinistry(ctx, ['ANALYST']);
    const { icd11Code, chapter } = req.query as { icd11Code?: string; chapter?: string };
    return burdenByCounty(prisma, { ...periodFrom(req.query as never), icd11Code, chapter });
  });

  app.get<{ Params: { countyId: string } }>(
    `${v1}/analytics/burden/:countyId`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx, ['ANALYST']);
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
    requireMinistry(ctx, ['ANALYST']);
    return referralClosureByCounty(prisma, periodFrom(req.query as never));
  });

  app.get(`${v1}/analytics/workforce`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['ANALYST']);
    const { from } = periodFrom(req.query as never);
    return workforceByCounty(prisma, { since: from });
  });

  app.get(`${v1}/analytics/care-gaps`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['ANALYST']);
    return careGaps(prisma);
  });

  app.get(`${v1}/analytics/surveillance`, async (req) => {
    const ctx = await contextFrom(req);
    // Notifiable-disease signals belong to SURVEILLANCE, not to every
      // analyst who can read a burden chart.
    requireMinistry(ctx, ['SURVEILLANCE']);
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
    // Recomputing the national rollup rewrites what every other figure is
    // derived from. Deliberately the narrowest role on the surface.
    requireMinistry(ctx, ['SUPER_ADMIN']);
    return rollupConditions(prisma, periodFrom(req.query as never));
  });

  // ------------------------------------------------------------------ admin
  //
  // The Ministry portal is the platform administrator, and these are the
  // actions behind it. Each is bound to the role that owns it — REGISTRAR
  // approves facilities and posts staff, AUDITOR reviews break-glass — and
  // SUPER_ADMIN holds all of them.
  //
  // Every route here reads or writes ADMINISTRATIVE data: facilities,
  // licences, affiliations, audit rows. None of them returns clinical
  // content, and the break-glass reviews deliberately carry the justification
  // and the actor without the record that was opened.

  /** Facilities awaiting a registrar's decision. */
  app.get(`${v1}/admin/facilities/pending`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);
    return prisma.facility.findMany({
      where: { registrationStatus: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        mflCode: true,
        name: true,
        kephLevel: true,
        ownership: true,
        countyId: true,
        subcountyId: true,
        locality: true,
        createdAt: true,
      },
    });
  });

  /**
   * Find the person who will direct a facility.
   *
   * Answers one question — does this identifier belong to somebody already
   * registered — and returns a name and nothing else. No clinical data, no
   * contact details, one match at most: a register that answers "who is
   * 12345678" in bulk is a register that leaks.
   *
   * Unauthenticated because facility registration is, but deliberately
   * narrow for the same reason.
   */
  app.get<{ Querystring: { identifier?: string } }>(
    `${v1}/facilities/directors/search`,
    async (req) => {
      const identifier = (req.query.identifier ?? '').trim();
      if (identifier.length < 6) {
        throw new FacilityError(
          'Give a full National ID, NHP number or licence number.',
          'IDENTIFIER_TOO_SHORT',
        );
      }

      // A licence number first, since that is what a clinician-owner knows.
      const licence = await prisma.licence.findFirst({
        where: { licenceNumber: identifier.toUpperCase() },
        select: { practitioner: { select: { personId: true } } },
      });

      let personId = licence?.practitioner?.personId ?? null;

      // An NHP number — the one identifier a citizen can read off their own
      // record, and so the one a non-clinical owner is most likely to have.
      if (!personId && /^NHP-/i.test(identifier)) {
        const byNhp = await prisma.person.findUnique({
          where: { displayNumber: identifier.toUpperCase() },
          select: { id: true },
        });
        personId = byNhp?.id ?? null;
      }

      if (!personId) {
        const match = await prisma.identifier.findFirst({
          where: {
            type: 'NATIONAL_ID',
            valueIndex: blindIndex(identifier),
            status: 'ACTIVE',
          },
          select: { personId: true },
        });
        personId = match?.personId ?? null;
      }

      if (!personId) return { match: null };

      const person = await prisma.person.findUnique({
        where: { id: personId },
        select: { id: true, givenName: true, familyName: true },
      });
      if (!person) return { match: null };

      return {
        match: {
          personId: person.id,
          givenName: decryptField(person.givenName),
          familyName: decryptField(person.familyName),
        },
      };
    },
  );

  /**
   * Correcting a public facility's details.
   *
   * PUBLIC ONLY, and that restriction is the point. A public facility is
   * the Ministry's own, so it is theirs to correct. A private one's details
   * belong to the people who run it, and letting the Ministry silently
   * rewrite them would make the register unreliable in the other direction
   * — nobody could tell whether what they filed is what is stored.
   */
  app.patch<{
    Params: { facilityId: string };
    Body: {
      name?: string;
      phone?: string;
      email?: string;
      locality?: string;
      kephLevel?: number;
    };
  }>(`${v1}/admin/facilities/:facilityId`, async (req) => {
    const ctx = await contextFrom(req);
    const ministryUserId = requireMinistry(ctx, ['REGISTRAR']);

    const facility = await prisma.facility.findUnique({
      where: { id: req.params.facilityId },
      select: { id: true, name: true, ownership: true },
    });
    if (!facility) throw new FacilityError('Facility not found', 'FACILITY_NOT_FOUND');

    const isPublicFacility =
      facility.ownership === 'PUBLIC_MOH' || facility.ownership === 'PUBLIC_OTHER';
    if (!isPublicFacility) {
      throw new FacilityError(
        `${facility.name} is ${facility.ownership}. The Ministry may correct a ` +
          'public facility; a private one is corrected by the people who run it.',
        'NOT_A_PUBLIC_FACILITY',
      );
    }

    const b = req.body;
    const updated = await prisma.facility.update({
      where: { id: facility.id },
      data: {
        ...(b.name !== undefined ? { name: b.name.trim() } : {}),
        ...(b.phone !== undefined ? { phone: b.phone.trim() || null } : {}),
        ...(b.email !== undefined ? { email: b.email.trim() || null } : {}),
        ...(b.locality !== undefined ? { locality: b.locality.trim() } : {}),
        ...(b.kephLevel !== undefined ? { kephLevel: b.kephLevel } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        locality: true,
        kephLevel: true,
      },
    });

    req.log.info(
      { facilityId: facility.id, ministryUserId },
      'ministry updated a public facility',
    );
    return updated;
  });

  app.post<{ Params: { facilityId: string } }>(
    `${v1}/admin/facilities/:facilityId/approve`,
    async (req) => {
      const ctx = await contextFrom(req);
      const ministryUserId = requireMinistry(ctx, ['REGISTRAR']);
      // Approval is attributed: `approveFacility` records who decided.
      return approveFacility(prisma, req.params.facilityId, ministryUserId);
    },
  );

  /** The register of facilities, for the administrative overview. */
  app.get(`${v1}/admin/facilities`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);
    const { status, countyId } = req.query as { status?: string; countyId?: string };
    return prisma.facility.findMany({
      where: {
        ...(status ? { registrationStatus: status as never } : {}),
        ...(countyId ? { countyId } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
      select: {
        id: true,
        mflCode: true,
        name: true,
        kephLevel: true,
        ownership: true,
        countyId: true,
        registrationStatus: true,
      },
    });
  });

  /**
   * Posting staff to a facility.
   *
   * `grantAffiliation` enforces the rule that matters: the Ministry posts
   * to PUBLIC facilities, private facilities engage their own. A registrar
   * calling this against a private clinic is refused by the service, not by
   * a check here that could be forgotten.
   */
  app.post<{ Body: { practitionerId: string; facilityId: string; role?: string } }>(
    `${v1}/admin/postings`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['practitionerId', 'facilityId'],
          properties: {
            practitionerId: { type: 'string', minLength: 1 },
            facilityId: { type: 'string', minLength: 1 },
            role: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      const ministryUserId = requireMinistry(ctx, ['REGISTRAR']);
      return grantAffiliation(prisma, {
        practitionerId: req.body.practitionerId,
        facilityId: req.body.facilityId,
        role: req.body.role as never,
        grantedBy: ministryUserId,
        grantedByKind: 'MINISTRY',
      });
    },
  );

  app.post<{ Params: { affiliationId: string } }>(
    `${v1}/admin/postings/:affiliationId/end`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx, ['REGISTRAR']);
      return endAffiliation(prisma, req.params.affiliationId);
    },
  );

  /**
   * Practitioner search, for a registrar about to post someone.
   *
   * By licence number: names are encrypted with no blind index, and a
   * licence is what a registrar is actually working from.
   */
  app.get<{ Querystring: { q?: string } }>(
    `${v1}/admin/practitioners/search`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx, ['REGISTRAR']);
      return searchPractitioners(prisma, req.query.q ?? '');
    },
  );

  /**
   * Facility search, for the same screen.
   *
   * Carries `ownership` on every row because it decides whether the Ministry
   * may post here at all — a registrar choosing blind would pick a private
   * clinic and meet the refusal afterwards.
   */
  app.get<{ Querystring: { q?: string; countyId?: string } }>(
    `${v1}/admin/facilities/search`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx, ['REGISTRAR']);
      const q = (req.query.q ?? '').trim();

      return prisma.facility.findMany({
        where: {
          // Only ACTIVE: an unapproved facility can hold no affiliation, so
          // offering it would be offering a refusal.
          registrationStatus: 'ACTIVE',
          ...(req.query.countyId ? { countyId: req.query.countyId } : {}),
          ...(q.length >= 2
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' as const } },
                  { mflCode: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { name: 'asc' },
        take: 20,
        select: {
          id: true,
          mflCode: true,
          name: true,
          kephLevel: true,
          ownership: true,
          countyId: true,
        },
      });
    },
  );

  /** Licences about to lapse — a clinician whose licence expires cannot write. */
  app.get(`${v1}/admin/licences/expiring`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);
    const { days } = req.query as { days?: string };
    return licencesExpiringSoon(prisma, days ? Number(days) : 30);
  });

  /**
   * The facility register, with the analytics a registrar reads it for.
   *
   * Counts by status, KEPH level and ownership — the three things that
   * decide what a facility may do. Ownership is not a curiosity here: it
   * decides who may staff every facility in the count.
   */
  app.get(`${v1}/admin/facilities/stats`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);

    const [byStatus, byLevel, byOwnership, byCounty, withCapabilities, total] =
      await Promise.all([
        prisma.facility.groupBy({ by: ['registrationStatus'], _count: { _all: true } }),
        prisma.facility.groupBy({
          by: ['kephLevel'],
          where: { registrationStatus: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.facility.groupBy({
          by: ['ownership'],
          where: { registrationStatus: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.facility.groupBy({
          by: ['countyId'],
          where: { registrationStatus: 'ACTIVE' },
          _count: { _all: true },
        }),
        prisma.facility.count({
          where: { registrationStatus: 'ACTIVE', capabilities: { some: {} } },
        }),
        prisma.facility.count(),
      ]);

    const active = byStatus.find((s) => s.registrationStatus === 'ACTIVE')?._count._all ?? 0;

    return {
      total,
      byStatus: byStatus.map((r) => ({ status: r.registrationStatus, count: r._count._all })),
      byKephLevel: byLevel
        .map((r) => ({ kephLevel: r.kephLevel, count: r._count._all }))
        .sort((a, b) => a.kephLevel - b.kephLevel),
      byOwnership: byOwnership
        .map((r) => ({ ownership: r.ownership, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      byCounty: byCounty
        .map((r) => ({ countyId: r.countyId, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      // A facility with no declared capabilities cannot be recommended to a
      // patient, so it is registered but invisible to care routing.
      activeWithoutCapabilities: active - withCapabilities,
    };
  });

  /**
   * The workforce register.
   *
   * Counts by cadre, by licence status and by affiliation, because an
   * unaffiliated clinician is registered but cannot treat anyone — a number
   * that looks like workforce and is not.
   */
  app.get(`${v1}/admin/practitioners/stats`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);

    const [byCadre, byStatus, byCounty, total, affiliated, licensed] = await Promise.all([
      prisma.practitioner.groupBy({ by: ['cadre'], _count: { _all: true } }),
      prisma.practitioner.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.practitioner.groupBy({ by: ['countyId'], _count: { _all: true } }),
      prisma.practitioner.count(),
      prisma.practitioner.count({ where: { affiliations: { some: { status: 'ACTIVE' } } } }),
      prisma.practitioner.count({
        where: { licences: { some: { status: 'ACTIVE', expiresOn: { gte: new Date() } } } },
      }),
    ]);

    return {
      total,
      byCadre: byCadre
        .map((r) => ({ cadre: r.cadre, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byCounty: byCounty
        .map((r) => ({ countyId: r.countyId, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      // The two numbers that separate "registered" from "able to work".
      withActiveLicence: licensed,
      withActiveAffiliation: affiliated,
      unaffiliated: total - affiliated,
    };
  });

  /** The workforce list itself, paged. Administrative fields only. */
  app.get<{ Querystring: { cadre?: string; countyId?: string; skip?: string } }>(
    `${v1}/admin/practitioners`,
    async (req) => {
      const ctx = await contextFrom(req);
      requireMinistry(ctx, ['REGISTRAR']);
      const { cadre, countyId, skip } = req.query;

      const where = {
        ...(cadre ? { cadre: cadre as never } : {}),
        ...(countyId ? { countyId } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.practitioner.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: skip ? Number(skip) : 0,
          take: 50,
          select: {
            id: true,
            cadre: true,
            status: true,
            countyId: true,
            createdAt: true,
            licences: {
              select: { regulator: true, licenceNumber: true, status: true, expiresOn: true },
              orderBy: { expiresOn: 'desc' },
              take: 1,
            },
            affiliations: {
              where: { status: 'ACTIVE' },
              select: { facility: { select: { name: true } } },
            },
          },
        }),
        prisma.practitioner.count({ where }),
      ]);

      return {
        total,
        rows: rows.map((p) => ({
          practitionerId: p.id,
          cadre: p.cadre,
          status: p.status,
          countyId: p.countyId,
          registeredAt: p.createdAt,
          licence: p.licences[0] ?? null,
          facilities: p.affiliations.map((a) => a.facility.name),
        })),
      };
    },
  );

  /**
   * The population register.
   *
   * Counts only. There is deliberately NO endpoint that lists citizens:
   * `nhp_analyst` has every table grant revoked but aggregates, and a
   * browsable register of every citizen in Kenya would be the single
   * highest-value target in the country. An administrator running the
   * programme needs distributions, not names.
   */
  app.get(`${v1}/admin/citizens/stats`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['REGISTRAR']);

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [total, byCounty, byMaturity, byVerification, bySex, thisMonth, deceased] =
      await Promise.all([
        prisma.person.count(),
        prisma.person.groupBy({ by: ['countyId'], _count: { _all: true } }),
        prisma.person.groupBy({ by: ['maturity'], _count: { _all: true } }),
        prisma.person.groupBy({ by: ['verificationState'], _count: { _all: true } }),
        prisma.person.groupBy({ by: ['sexAtBirth'], _count: { _all: true } }),
        prisma.person.count({ where: { createdAt: { gte: monthStart } } }),
        prisma.person.count({ where: { lifeStatus: { not: 'ALIVE' } } }),
      ]);

    return {
      total,
      registeredThisMonth: thisMonth,
      byCounty: byCounty
        .map((r) => ({ countyId: r.countyId, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
      byMaturity: byMaturity.map((r) => ({ maturity: r.maturity, count: r._count._all })),
      // The gap an administrator is actually trying to close: a person whose
      // identity is unverified still has a record, but a facility cannot
      // trust the ID they present.
      byVerification: byVerification.map((r) => ({
        state: r.verificationState,
        count: r._count._all,
      })),
      bySex: bySex.map((r) => ({ sex: r.sexAtBirth, count: r._count._all })),
      notAlive: deceased,
    };
  });

  /**
   * Looking up ONE citizen, for a support case.
   *
   * Deliberately a lookup and not a list: an exact National ID or NHP
   * number returns one person or none. There is no way to page through the
   * register, so a leaked Ministry account cannot be used to exfiltrate it.
   *
   * Returns registration details ONLY — never clinical data, which lives
   * behind the practitioner check-in gate and is not a Ministry capability
   * at any role.
   *
   * Every lookup is written to the citizen's own access log and appears on
   * their access screen, exactly like a clinician opening their record. An
   * administrative power that the subject cannot see is the one that gets
   * abused.
   */
  app.get<{ Querystring: { identifier?: string } }>(
    `${v1}/admin/citizens/lookup`,
    async (req) => {
      const ctx = await contextFrom(req);
      const ministryUserId = requireMinistry(ctx, ['REGISTRAR']);

      const identifier = (req.query.identifier ?? '').trim();
      if (identifier.length < 4) {
        throw new IdentityError(
          'Enter a full National ID or NHP number',
          'MISSING_IDENTIFIER',
        );
      }

      const found = await searchByIdentifier(prisma, identifier);
      const match =
        found.match ??
        (await prisma.person
          .findUnique({
            where: { displayNumber: identifier.toUpperCase() },
            select: {
              id: true,
              displayNumber: true,
              givenName: true,
              familyName: true,
              dateOfBirth: true,
              maturity: true,
              sexAtBirth: true,
              verificationState: true,
              countyId: true,
              lifeStatus: true,
              createdAt: true,
            },
          })
          .then((p) =>
            p
              ? {
                  ...p,
                  givenName: decryptField(p.givenName),
                  familyName: decryptField(p.familyName),
                }
              : null,
          ));

      if (match) {
        // Logged BEFORE returning, and as MINISTRY — logging a registrar as
        // a practitioner would put a clinician who never opened the record
        // on that citizen's own access screen.
        await logAccess(prisma, {
          personId: match.id,
          practitionerId: ministryUserId,
          actorKind: 'MINISTRY',
          action: 'SEARCH',
          tierReached: 'TIER_1_EMERGENCY',
          reason: 'ADMIN',
          outcome: 'GRANTED',
          requestId: req.id,
          targetTable: 'person',
          targetId: match.id,
        });
      }

      req.log.warn(
        { ministryUserId, found: Boolean(match) },
        'ministry citizen lookup',
      );

      // No dependants, no clinical content, no listing — one person or none.
      return { match: match ?? null };
    },
  );

  /** Break-glass events awaiting review. The AUDITOR's queue. */
  app.get(`${v1}/admin/break-glass/pending`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['AUDITOR']);
    return pendingBreakGlassReviews(prisma);
  });

  app.post<{
    Params: { breakGlassId: string };
    Body: { outcome: 'REVIEWED_OK' | 'FLAGGED' | 'ESCALATED'; note?: string };
  }>(
    `${v1}/admin/break-glass/:breakGlassId/review`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['outcome'],
          properties: {
            outcome: { type: 'string', enum: ['REVIEWED_OK', 'FLAGGED', 'ESCALATED'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      const ministryUserId = requireMinistry(ctx, ['AUDITOR']);
      return reviewBreakGlass(prisma, {
        breakGlassId: req.params.breakGlassId,
        ministryUserId,
        outcome: req.body.outcome,
        note: req.body.note,
      });
    },
  );

  /** Break-glass rate per facility — an outlier is the signal worth chasing. */
  app.get(`${v1}/admin/break-glass/rates`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['AUDITOR']);
    return breakGlassRateByFacility(prisma, periodFrom(req.query as never).from);
  });

  /** Actors whose access is refused unusually often — probing looks like this. */
  app.get(`${v1}/admin/anomalies`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx, ['AUDITOR']);
    return denialAnomalies(prisma, periodFrom(req.query as never).from);
  });

  /**
   * The administrative overview.
   *
   * Deliberately returns only what the caller's role may act on. A section
   * with a count the role cannot open is worse than an absent one: it
   * advertises a capability and then refuses it.
   */
  app.get(`${v1}/admin/overview`, async (req) => {
    const ctx = await contextFrom(req);
    requireMinistry(ctx);

    const role = ctx.ministryRole;
    const all = role === 'SUPER_ADMIN';
    const can = (r: string) => all || role === r;

    const [pendingFacilities, activeFacilities, practitioners, pendingReviews, expiring] =
      await Promise.all([
        can('REGISTRAR')
          ? prisma.facility.count({ where: { registrationStatus: 'PENDING' } })
          : null,
        can('REGISTRAR')
          ? prisma.facility.count({ where: { registrationStatus: 'ACTIVE' } })
          : null,
        can('REGISTRAR') ? prisma.practitioner.count() : null,
        can('AUDITOR') ? prisma.breakGlass.count({ where: { reviewStatus: 'PENDING' } }) : null,
        can('REGISTRAR') ? licencesExpiringSoon(prisma, 30).then((l) => l.length) : null,
      ]);

    return {
      role: role ?? null,
      geoScope: ctx.geoScope ?? null,
      // null means "not your role", which the UI renders as an absent
      // section rather than a zero.
      pendingFacilities,
      activeFacilities,
      practitioners,
      pendingBreakGlassReviews: pendingReviews,
      licencesExpiringSoon: expiring,
    };
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

  /**
   * The citizen's own profile.
   *
   * Identity fields are returned but NOT editable: name, National ID, date
   * of birth and sex are what a facility matches a person on, and a
   * self-service edit is how someone quietly becomes a different person.
   * A correction goes through the dispute route, where a facility reviews it.
   *
   * The National ID is masked. A citizen already knows their own number, so
   * showing it in full only creates a shoulder-surfing target on a shared
   * handset.
   */
  app.get(`${v1}/persons/me/profile`, async (req) => {
    const ctx = await contextFrom(req);
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }

    const [person, account, identifier] = await Promise.all([
      prisma.person.findUnique({
        where: { id: ctx.personId },
        select: {
          displayNumber: true,
          givenName: true,
          middleName: true,
          familyName: true,
          dateOfBirth: true,
          sexAtBirth: true,
          bloodGroup: true,
          countyId: true,
          subcountyId: true,
          maturity: true,
          verificationState: true,
          photo: true,
        },
      }),
      prisma.account.findFirst({
        where: { personId: ctx.personId },
        select: { phone: true, email: true, mfaMode: true },
      }),
      prisma.identifier.findFirst({
        where: { personId: ctx.personId, type: 'NATIONAL_ID', status: 'ACTIVE' },
        select: { value: true },
      }),
    ]);

    if (!person) throw new IdentityError('Record not found', 'PERSON_NOT_FOUND');

    const nationalId = identifier ? decryptField(identifier.value) : null;

    return {
      // Editable by the citizen.
      contact: {
        phone: account ? decryptField(account.phone) : null,
        email: account?.email ? decryptField(account.email) : null,
      },
      photo: decryptPhoto(person.photo),
      mfaMode: account?.mfaMode ?? 'NONE',

      // Read-only. Shown so a citizen can SEE an error and report it.
      identity: {
        displayNumber: person.displayNumber,
        givenName: decryptField(person.givenName),
        middleName: person.middleName ? decryptField(person.middleName) : null,
        familyName: decryptField(person.familyName),
        dateOfBirth: person.dateOfBirth,
        sexAtBirth: person.sexAtBirth,
        bloodGroup: person.bloodGroup,
        // Last two digits only.
        nationalIdMasked: nationalId
          ? `${'•'.repeat(Math.max(0, nationalId.length - 2))}${nationalId.slice(-2)}`
          : null,
        verificationState: person.verificationState,
      },
      countyId: person.countyId,
      subcountyId: person.subcountyId,
    };
  });

  /** Updating what a citizen may change about themselves. */
  app.patch<{ Body: { phone?: string; email?: string } }>(
    `${v1}/persons/me/profile`,
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            phone: { type: 'string', minLength: 9, maxLength: 20 },
            // An empty string clears the address, which is why minLength is 0.
            email: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      if (!ctx.personId) {
        throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
      }

      const account = await prisma.account.findFirst({
        where: { personId: ctx.personId },
        select: { id: true },
      });
      if (!account) throw new IdentityError('Account not found', 'ACCOUNT_NOT_FOUND');

      const data: Record<string, unknown> = {};

      if (req.body.phone !== undefined) {
        const phoneIndex = blindIndex(req.body.phone, normalisePhone);
        // The phone is how they sign in and how their security codes reach
        // them; two accounts on one number would make both unreachable.
        const taken = await prisma.account.findUnique({
          where: { phoneIndex },
          select: { id: true },
        });
        if (taken && taken.id !== account.id) {
          throw new IdentityError('That phone number is already in use', 'PHONE_IN_USE');
        }
        data.phone = encryptField(req.body.phone);
        data.phoneIndex = phoneIndex;
        // Changing the number invalidates the verification of the old one.
        data.phoneVerifiedAt = null;
      }

      if (req.body.email !== undefined) {
        const email = req.body.email.trim();
        data.email = email ? encryptField(email) : null;
        data.emailIndex = email ? blindIndex(email) : null;
      }

      if (Object.keys(data).length === 0) {
        throw new IdentityError('Nothing to update', 'NOTHING_TO_UPDATE');
      }

      await prisma.account.update({ where: { id: account.id }, data });
      return { updated: Object.keys(data) };
    },
  );

  /**
   * The children a citizen is guardian to.
   *
   * A dependant registered by a parent is SELF_DECLARED and starts
   * UNVERIFIED — not yet searchable by facilities — until a clinician
   * attests it. Without that gate any adult could fabricate a child, so the
   * response says plainly which state each one is in.
   */
  app.get(`${v1}/persons/me/family`, async (req) => {
    const ctx = await contextFrom(req);
    if (!ctx.personId) {
      throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
    }

    const links = await prisma.guardianship.findMany({
      where: { guardianId: ctx.personId, status: 'ACTIVE' },
      select: {
        id: true,
        relationship: true,
        isPrimary: true,
        evidence: true,
        dependant: {
          select: {
            id: true,
            displayNumber: true,
            givenName: true,
            familyName: true,
            dateOfBirth: true,
            sexAtBirth: true,
            maturity: true,
            verificationState: true,
            photo: true,
          },
        },
      },
    });

    return links.map((l) => ({
      guardianshipId: l.id,
      relationship: l.relationship,
      isPrimary: l.isPrimary,
      evidence: l.evidence,
      child: {
        displayNumber: l.dependant.displayNumber,
        givenName: decryptField(l.dependant.givenName),
        familyName: decryptField(l.dependant.familyName),
        dateOfBirth: l.dependant.dateOfBirth,
        ageYears: ageAt(l.dependant.dateOfBirth),
        sexAtBirth: l.dependant.sexAtBirth,
        maturity: l.dependant.maturity,
        // The thing a parent needs to know: whether a facility can find them.
        verified: l.dependant.verificationState === 'VERIFIED',
        verificationState: l.dependant.verificationState,
        photo: decryptPhoto(l.dependant.photo),
      },
    }));
  });

  /** Registering a child. */
  app.post<{
    Body: {
      givenName: string;
      middleName?: string;
      familyName: string;
      sexAtBirth: 'MALE' | 'FEMALE' | 'INTERSEX';
      dateOfBirth: string;
      relationship: string;
      birthCertNumber?: string;
      photo?: string;
    };
  }>(
    `${v1}/persons/me/family`,
    {
      schema: {
        body: {
          type: 'object',
          required: ['givenName', 'familyName', 'sexAtBirth', 'dateOfBirth', 'relationship'],
          properties: {
            givenName: { type: 'string', minLength: 1, maxLength: 80 },
            middleName: { type: 'string', maxLength: 80 },
            familyName: { type: 'string', minLength: 1, maxLength: 80 },
            sexAtBirth: { type: 'string', enum: ['MALE', 'FEMALE', 'INTERSEX'] },
            dateOfBirth: { type: 'string', minLength: 10 },
            relationship: {
              type: 'string',
              enum: ['MOTHER', 'FATHER', 'LEGAL_GUARDIAN', 'GRANDPARENT', 'FOSTER', 'OTHER'],
            },
            birthCertNumber: { type: 'string', maxLength: 40 },
            photo: { type: 'string', maxLength: 400_000 },
          },
        },
      },
    },
    async (req) => {
      const ctx = await contextFrom(req);
      if (!ctx.personId) {
        throw new AuthError('This endpoint is for citizen accounts', 'NOT_A_CITIZEN', 403);
      }

      const dob = parseDob(req.body.dateOfBirth);
      const child = await registerDependant(prisma, {
        guardianPersonId: ctx.personId,
        relationship: req.body.relationship as never,
        // SELF_DECLARED by construction: a parent typing into a form has
        // shown nobody a birth certificate. A facility upgrades this.
        evidence: req.body.birthCertNumber ? 'BIRTH_CERT' : 'SELF_DECLARED',
        birthCertNumber: req.body.birthCertNumber,
        givenName: req.body.givenName,
        middleName: req.body.middleName,
        familyName: req.body.familyName,
        sexAtBirth: req.body.sexAtBirth,
        dateOfBirth: dob,
        registeredBy: ctx.personId,
        registrationRoute: 'GUARDIAN',
      });

      if (req.body.photo) {
        await prisma.person.update({
          where: { id: child.id },
          data: { photo: encryptPhoto(req.body.photo) },
        });
      }

      return {
        displayNumber: child.displayNumber,
        verified: child.verificationState === 'VERIFIED',
        message:
          child.verificationState === 'VERIFIED'
            ? 'Added to your family.'
            : 'Added. Take their birth certificate to any facility and they ' +
              'will confirm the record — until then a facility cannot find it.',
      };
    },
  );

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
      /** A KEML code, or 'UNCODED' for a medicine not on the list. */
      kemlCode: string;
      /** Required when kemlCode is 'UNCODED'; ignored otherwise. */
      genericName?: string;
      /** Only read for an uncoded medicine; a coded one uses the formulary route. */
      route?: 'ORAL' | 'IV' | 'IM' | 'SC' | 'TOPICAL' | 'INHALED' | 'RECTAL';
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
