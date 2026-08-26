/**
 * A working demo scenario.
 *
 * Creates one facility, one checked-in doctor, and one patient with the
 * clinical history the encounter wireframes depict — a penicillin
 * anaphylaxis, two chronic conditions, current medications.
 *
 * Everything goes through the real service layer, so the check-in gate, the
 * licence check and the append-only triggers all apply. If this script runs,
 * the API genuinely works.
 *
 *   pnpm seed:demo
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { registerAdult } from './identity.js';
import { registerFacility, approveFacility, claimCapability } from './facility.js';
import { registerPractitioner, grantAffiliation, checkIn } from './practitioner.js';
import {
  openEncounter,
  recordDiagnosis,
  recordAllergy,
  prescribe,
  recordObservation,
  recordProcedure,
} from './clinical.js';
import { hashPassword, enrolSms, confirmSms } from './auth.js';
import { ConsoleSmsProvider, setSmsProvider } from './notify.js';
import { encryptField, blindIndex, normalisePhone } from './crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** Captures the enrolment code so the demo can confirm it automatically. */
const smsBuffer = new ConsoleSmsProvider();
setSmsProvider(smsBuffer);

/**
 * Clears the operational tables, leaving the reference data (counties,
 * subcounties, vocabularies) that `pnpm seed` loads.
 *
 * Order matters — children before parents. `session_replication_role` is
 * set to `replica` so the append-only triggers on the clinical tables do
 * not refuse the delete: those triggers exist to stop the APPLICATION
 * rewriting history, and this runs as the owner against a dev database.
 */
async function reset() {
  const tables = [
    'agg_condition_daily', 'recommendation', 'counter_referral', 'referral',
    'observation', 'procedure', 'condition', 'medication', 'allergy',
    'encounter', 'access_log', 'break_glass', 'consent_grant', 'check_in',
    'affiliation', 'licence', 'practitioner', 'facility_capability',
    'facility', 'guardianship', 'identifier', 'otp_challenge',
    'refresh_token', 'ministry_user', 'account', 'person',
  ];
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t}`);
  }
  await prisma.$executeRawUnsafe(`SET session_replication_role = origin`);
  console.log(`reset: cleared ${tables.length} tables\n`);
}

async function main() {
  const county = await prisma.county.findFirstOrThrow({ where: { code: '042' } });
  const subcounty = await prisma.subCounty.findFirstOrThrow({
    where: { countyId: county.id },
  });

  // `--reset` was previously advertised in the skip message and wired into
  // package.json, but nothing read argv — so `pnpm demo:reset` hit the
  // guard below and printed credentials for accounts it had not created.
  const wantsReset = process.argv.includes('--reset');
  if (wantsReset) await reset();

  // Idempotent: re-running should not fail on a duplicate National ID.
  const existing = await prisma.identifier.findFirst({
    where: { valueIndex: { not: '' } },
    select: { id: true },
  });
  if (existing) {
    console.log('Demo data already present. Run `pnpm demo:reset` to rebuild.\n');
    await report();
    return;
  }

  console.log('building the demo scenario ...\n');

  const facility = await registerFacility(prisma, {
    mflCode: 'MFL-DEMO-1',
    name: 'Kisumu County Referral',
    kephLevel: 5,
    ownership: 'PUBLIC_MOH',
    countyId: county.id,
    subcountyId: subcounty.id,
    locality: 'Milimani',
    latitude: -0.0917,
    longitude: 34.768,
    is24Hour: true,
    bedCapacity: 420,
  });
  await approveFacility(prisma, facility.id, 'ministry-demo');
  for (const cap of ['OPD_GENERAL', 'EMERGENCY_24H', 'LAB_BASIC', 'MALARIA_RDT', 'PHARMACY']) {
    await claimCapability(prisma, { facilityId: facility.id, capabilityCode: cap });
  }

  const doctorPerson = await registerAdult(prisma, {
    nationalId: '12345678',
    phone: '0722111222',
    givenName: 'Amina',
    familyName: 'Wanjiru',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1988, 2, 14)),
    countyId: county.id,
    subcountyId: subcounty.id,
    passwordHash: 'argon2id$demo',
  });

  const { practitioner } = await registerPractitioner(prisma, {
    personId: doctorPerson.id,
    cadre: 'DOCTOR',
    countyId: county.id,
    subcountyId: subcounty.id,
    licenceNumber: 'KMPDC/12345',
    familyName: 'Wanjiru',
  });

  // A clinical account with its own credentials and a second factor. The
  // person-scoped account created at registration is the doctor's CITIZEN
  // login; this is their clinical one, and the two must stay separate — a
  // doctor must not reach their own medical record through a clinical
  // session.
  const doctorPhone = '0722111333';
  const clinicalAccount = await prisma.account.create({
    data: {
      practitionerId: practitioner.id,
      phone: encryptField(doctorPhone),
      phoneIndex: blindIndex(doctorPhone, normalisePhone),
      passwordHash: await hashPassword('demo-password-123'),
      status: 'ACTIVE',
    },
  });

  // SMS is the demo default: it is the primary channel for Kenya, and the
  // console provider prints the code so the flow is testable end to end.
  await enrolSms(prisma, clinicalAccount.id);
  const enrolCode = smsBuffer.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
  if (!enrolCode) throw new Error('Enrolment code was not sent');
  await confirmSms(prisma, clinicalAccount.id, enrolCode);

  await grantAffiliation(prisma, {
    practitionerId: practitioner.id,
    facilityId: facility.id,
    grantedBy: 'ministry-demo',
    grantedByKind: 'MINISTRY',
  });
  await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });

  // The patient from the wireframes.
  const patient = await registerAdult(prisma, {
    nationalId: '39104882',
    phone: '0712345678',
    givenName: "Achieng'",
    middleName: 'Otieno',
    familyName: 'Wanjala',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1992, 4, 15)),
    countyId: county.id,
    subcountyId: subcounty.id,
    passwordHash: 'argon2id$demo',
  });
  await prisma.person.update({
    where: { id: patient.id },
    data: { bloodGroup: 'O_POS' },
  });

  /*
   * The facility administrator.
   *
   * A separate human being from the doctor, on purpose. FACILITY_ADMIN is a
   * role a practitioner holds, not a fourth kind of account, and the demo
   * has to show that without also implying every administrator sees
   * patients. This one is a records officer: a real cadre at a Kenyan
   * hospital, holding no clinical licence that would let them write to a
   * clinical table.
   *
   * The grant is MINISTRY-issued because the demo facility is PUBLIC_MOH,
   * and `grantAffiliation` refuses a facility-issued grant at a public
   * facility by design.
   */
  const adminPerson = await registerAdult(prisma, {
    nationalId: '28773451',
    phone: '0744333666',
    givenName: 'Peter',
    middleName: 'Kimani',
    familyName: 'Njoroge',
    sexAtBirth: 'MALE',
    dateOfBirth: new Date(Date.UTC(1985, 8, 2)),
    countyId: county.id,
    subcountyId: subcounty.id,
    passwordHash: 'argon2id$demo',
  });

  const { practitioner: adminPractitioner } = await registerPractitioner(prisma, {
    personId: adminPerson.id,
    cadre: 'RECEPTION',
    countyId: county.id,
    subcountyId: subcounty.id,
    // No licence, deliberately. Reception has no statutory register, and
    // issuing them one would fake the very credential the clinical gate
    // checks — this account must be unable to write clinical data, and the
    // demo is only honest if that is true rather than merely configured.
    familyName: 'Njoroge',
  });

  const adminPhone = '0744333777';
  const adminAccount = await prisma.account.create({
    data: {
      practitionerId: adminPractitioner.id,
      phone: encryptField(adminPhone),
      phoneIndex: blindIndex(adminPhone, normalisePhone),
      passwordHash: await hashPassword('admin-password-123'),
      status: 'ACTIVE',
    },
  });
  await enrolSms(prisma, adminAccount.id);
  const adminEnrolCode = smsBuffer.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
  if (!adminEnrolCode) throw new Error('Admin enrolment code was not sent');
  await confirmSms(prisma, adminAccount.id, adminEnrolCode);

  await grantAffiliation(prisma, {
    practitionerId: adminPractitioner.id,
    facilityId: facility.id,
    role: 'FACILITY_ADMIN',
    grantedBy: 'ministry-demo',
    grantedByKind: 'MINISTRY',
  });

  // A working citizen login, so the patient's own view is testable. No MFA:
  // citizens may enrol but are not required to — requiring a second factor
  // to read your own record would exclude the people it is meant to serve.
  await prisma.account.update({
    where: { personId: patient.id },
    data: { passwordHash: await hashPassword('patient-password-123') },
  });

  // The allergy that drives the contraindication interrupt.
  await recordAllergy(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    substanceKind: 'DRUG',
    substanceLabel: 'Penicillin',
    allergyClass: 'PENICILLIN',
    reaction: 'anaphylaxis',
    severity: 'ANAPHYLAXIS',
  });
  await recordAllergy(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    substanceKind: 'DRUG',
    substanceLabel: 'Sulfa',
    allergyClass: 'SULFONAMIDE',
    reaction: 'rash',
    severity: 'MODERATE',
  });

  // Chronic history, so the banner has something to show.
  const historic = await openEncounter(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    kind: 'OUTPATIENT',
    chiefComplaint: 'routine chronic disease review',
  });
  await recordDiagnosis(prisma, {
    practitionerId: practitioner.id,
    encounterId: historic.id,
    icd11Code: '5A11',
    isChronic: true,
  });
  await recordDiagnosis(prisma, {
    practitionerId: practitioner.id,
    encounterId: historic.id,
    icd11Code: 'BA00.Z',
    isChronic: true,
  });
  await prescribe(prisma, {
    practitionerId: practitioner.id,
    encounterId: historic.id,
    kemlCode: 'KEML-EN-001',
    doseAmount: 500,
    doseUnit: 'mg',
    frequency: 'BD',
    durationDays: 30,
  });
  await prescribe(prisma, {
    practitionerId: practitioner.id,
    encounterId: historic.id,
    kemlCode: 'KEML-CV-001',
    doseAmount: 5,
    doseUnit: 'mg',
    frequency: 'OD',
    durationDays: 30,
  });

  // A trend, not a single value — six HbA1c readings rising over 18 months.
  // The wireframes are specific: one number is a number, six are a finding.
  const hba1c = [6.8, 7.1, 7.4, 7.9, 8.1, 8.4];
  for (const [i, value] of hba1c.entries()) {
    const monthsAgo = (hba1c.length - 1 - i) * 3;
    await recordObservation(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      code: '4548-4',
      label: 'HbA1c',
      category: 'LAB',
      valueNum: value,
      unit: '%',
      refLow: 4.0,
      refHigh: 7.0,
      observedAt: new Date(Date.now() - monthsAgo * 30 * 86_400_000),
    });
  }

  for (const [i, systolic] of [138, 142, 145, 148].entries()) {
    await recordObservation(prisma, {
      practitionerId: practitioner.id,
      personId: patient.id,
      code: '8480-6',
      label: 'Systolic blood pressure',
      category: 'VITAL',
      valueNum: systolic,
      unit: 'mmHg',
      refLow: 90,
      refHigh: 140,
      observedAt: new Date(Date.now() - (3 - i) * 60 * 86_400_000),
    });
  }

  await recordObservation(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    code: '718-7',
    label: 'Haemoglobin',
    category: 'LAB',
    valueNum: 11.2,
    unit: 'g/dL',
    refLow: 11.0,
    refHigh: 15.0,
    observedAt: new Date(Date.now() - 20 * 86_400_000),
  });

  // A documented surgery, and one the patient only remembers — the
  // distinction a clinician must be able to see at a glance.
  await recordProcedure(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    code: 'JB40.0',
    title: 'Caesarean section',
    performedOn: new Date(Date.UTC(2022, 10, 9)),
    performedAtFacilityId: facility.id,
    indication: 'Failure to progress in labour',
    outcome: 'Live birth, mother and baby well',
  });

  await recordProcedure(prisma, {
    practitionerId: practitioner.id,
    personId: patient.id,
    code: 'JD10.0',
    title: 'Appendicectomy',
    performedOn: new Date(Date.UTC(2015, 0, 1)),
    datePrecision: 'YEAR',
    externalFacilityName: "St Mary's Mumias",
    indication: 'Acute appendicitis',
    isSelfReported: true,
  });

  // --- a Ministry ANALYST, and enough national data for the map ---
  //
  // The analyst is deliberately the narrowest Ministry role: aggregates
  // only, no path to an individual record.
  const analystPerson = await registerAdult(prisma, {
    nationalId: '87654321',
    phone: '0733222444',
    givenName: 'Joseph',
    familyName: 'Kamau',
    sexAtBirth: 'MALE',
    dateOfBirth: new Date(Date.UTC(1980, 5, 20)),
    countyId: county.id,
    subcountyId: subcounty.id,
    passwordHash: 'argon2id$demo',
  });

  const ministryUser = await prisma.ministryUser.create({
    data: {
      personId: analystPerson.id,
      role: 'ANALYST',
      geoScope: 'NATIONAL',
      mfaRequired: true,
    },
  });

  const analystPhone = '0733222555';
  const analystAccount = await prisma.account.create({
    data: {
      ministryUserId: ministryUser.id,
      phone: encryptField(analystPhone),
      phoneIndex: blindIndex(analystPhone, normalisePhone),
      passwordHash: await hashPassword('analyst-password-123'),
      status: 'ACTIVE',
    },
  });
  await enrolSms(prisma, analystAccount.id);
  const analystCode = smsBuffer.sent.at(-1)?.body.match(/\b(\d{6})\b/)?.[1];
  if (!analystCode) throw new Error('Analyst enrolment code was not sent');
  await confirmSms(prisma, analystAccount.id, analystCode);

  // Malaria cases across several counties, so the choropleth has variation
  // and the suppression rules actually bite somewhere.
  const spread: Array<[string, number]> = [
    ['042', 34], // Kisumu — high
    ['041', 28], // Siaya
    ['043', 19], // Homa Bay
    ['040', 12], // Busia
    ['047', 4],  // Nairobi — below threshold, will suppress
  ];

  for (const [code, cases] of spread) {
    // Skipping quietly here produced a map with two counties instead of
    // five and no indication anything was wrong — the reference data had
    // been deleted by a test run, and the demo just built a smaller world.
    const c = await prisma.county.findFirst({ where: { code } });
    if (!c) {
      throw new Error(
        `County ${code} is missing. Reference data is incomplete — run \`pnpm seed\` first.`,
      );
    }
    const sub = await prisma.subCounty.findFirst({ where: { countyId: c.id } });
    if (!sub) {
      throw new Error(
        `County ${c.name} (${code}) has no subcounties. Run \`pnpm seed\` first.`,
      );
    }

    const f = await registerFacility(prisma, {
      mflCode: `MFL-DEMO-${code}`,
      name: `${c.name} County Hospital`,
      kephLevel: 4,
      ownership: 'PUBLIC_MOH',
      countyId: c.id,
      subcountyId: sub.id,
      locality: 'Town centre',
      latitude: -0.5 + Math.random(),
      longitude: 34 + Math.random(),
    });
    await approveFacility(prisma, f.id, 'ministry-demo');

    const docPerson = await registerAdult(prisma, {
      nationalId: `9${code}00001`,
      phone: `0799${code}001`,
      givenName: 'Clinician',
      familyName: c.name,
      sexAtBirth: 'MALE',
      dateOfBirth: new Date(Date.UTC(1985, 0, 1)),
      countyId: c.id,
      subcountyId: sub.id,
      passwordHash: 'argon2id$demo',
    });
    const { practitioner: p } = await registerPractitioner(prisma, {
      personId: docPerson.id,
      cadre: 'CLINICAL_OFFICER',
      countyId: c.id,
      subcountyId: sub.id,
      licenceNumber: `COC/DEMO/${code}`,
    });
    await grantAffiliation(prisma, {
      practitionerId: p.id,
      facilityId: f.id,
      grantedBy: 'ministry-demo',
      grantedByKind: 'MINISTRY',
    });
    await checkIn(prisma, { practitionerId: p.id, facilityId: f.id });

    for (let i = 0; i < cases; i++) {
      const casePatient = await registerAdult(prisma, {
        nationalId: `9${code}${String(i + 100).padStart(5, '0')}`,
        phone: `07${code}${String(i + 1000).padStart(6, '0')}`,
        givenName: `Case${i}`,
        familyName: c.name,
        sexAtBirth: i % 2 === 0 ? 'FEMALE' : 'MALE',
        // Spread across adult age bands, so the rollup has real variation
        // without generating anyone under 18.
        dateOfBirth: new Date(Date.UTC(1950 + (i % 55), i % 12, 1 + (i % 28))),
        countyId: c.id,
        subcountyId: sub.id,
        passwordHash: 'argon2id$demo',
      });
      const enc = await openEncounter(prisma, {
        practitionerId: p.id,
        personId: casePatient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'fever',
      });
      await recordDiagnosis(prisma, {
        practitionerId: p.id,
        encounterId: enc.id,
        icd11Code: '1F41.0',
      });
    }
  }

  // Run the rollup, so the map reads aggregates rather than clinical rows.
  const { rollupConditions } = await import('./analytics.js');
  await rollupConditions(prisma, {
    from: new Date(Date.now() - 86_400_000),
    to: new Date(Date.now() + 86_400_000),
  });

  await report();
}

async function report() {
  // The doctor specifically. `findFirst` with no filter used to be
  // unambiguous; now that the demo also seeds an unlicensed reception
  // administrator it can return them instead, and the credentials block
  // printed "Dr Amina Wanjiru · undefined".
  const practitioner = await prisma.practitioner.findFirst({
    where: { cadre: 'DOCTOR' },
    include: { licences: true },
  });
  const patient = await prisma.person.findFirst({
    where: { displayNumber: { not: '' }, practitioner: null },
    orderBy: { createdAt: 'desc' },
  });
  const session = await prisma.checkIn.findFirst({
    where: { endedAt: null },
    include: { facility: true },
  });

  const clinical = await prisma.account.findFirst({
    where: { practitionerId: { not: null } },
  });

  // Verify each advertised login actually resolves before printing it.
  // This banner previously printed three sets of credentials unconditionally,
  // including on the skip path — so a database holding leftover test rows
  // produced a confident list of logins that all failed at the door.
  const missing: string[] = [];
  for (const phone of ['0722111333', '0733222555', '0712345678']) {
    const found = await prisma.account.findUnique({
      where: { phoneIndex: blindIndex(phone, normalisePhone) },
      select: { id: true },
    });
    if (!found) missing.push(phone);
  }
  if (missing.length > 0) {
    console.log(
      `WARNING: ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} ` +
        'not exist in this database.\n' +
        'The credentials below will NOT sign in. Run `pnpm demo:reset`.\n',
    );
  }

  console.log('DEMO CREDENTIALS\n');
  console.log('  phone     0722111333');
  console.log('  password  demo-password-123');
  console.log(`  2FA       ${clinical?.mfaMode ?? 'NONE'}\n`);
  console.log(`  doctor    Dr Amina Wanjiru · ${practitioner?.licences[0]?.licenceNumber}`);
  console.log(`  facility  ${session?.facility.name}`);
  console.log(`  session   expires ${session?.expiresAt.toISOString()}`);
  console.log(`  patient   ${patient?.displayNumber} · National ID 39104882`);
  console.log('\n  FACILITY ADMIN (the roster and reception desk, at /facility)');
  console.log('    phone     0744333777');
  console.log('    password  admin-password-123');
  console.log('    who       Peter Njoroge · records officer · holds NO licence');
  console.log('\n  MINISTRY ANALYST (the map, at /ministry)');
  console.log('    phone     0733222555');
  console.log('    password  analyst-password-123');
  console.log('\n  CITIZEN LOGIN (their own view, at /me)');
  console.log('    phone     0712345678');
  console.log('    password  patient-password-123');
  console.log(
    `\n  Second factor is SMS. In development the code is printed by the\n` +
      `  console provider — watch the \`pnpm serve\` output when you sign in.`,
  );

  console.log('\nsign in:');
  console.log(
    '  curl -sX POST localhost:4400/api/v1/auth/login \\\n' +
      '    -H "Content-Type: application/json" \\\n' +
      '    -d \'{"phone":"0722111333","password":"demo-password-123"}\'',
  );
}

main()
  .catch((err) => {
    console.error('demo seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
