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
import { openEncounter, recordDiagnosis, recordAllergy, prescribe } from './clinical.js';
import { hashPassword, enrolSms, confirmSms } from './auth.js';
import { ConsoleSmsProvider, setSmsProvider } from './notify.js';
import { encryptField, blindIndex, normalisePhone } from './crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** Captures the enrolment code so the demo can confirm it automatically. */
const smsBuffer = new ConsoleSmsProvider();
setSmsProvider(smsBuffer);

async function main() {
  const county = await prisma.county.findFirstOrThrow({ where: { code: '042' } });
  const subcounty = await prisma.subCounty.findFirstOrThrow({
    where: { countyId: county.id },
  });

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

  await report();
}

async function report() {
  const practitioner = await prisma.practitioner.findFirst({
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

  console.log('DEMO CREDENTIALS\n');
  console.log('  phone     0722111333');
  console.log('  password  demo-password-123');
  console.log(`  2FA       ${clinical?.mfaMode ?? 'NONE'}\n`);
  console.log(`  doctor    Dr Amina Wanjiru · ${practitioner?.licences[0]?.licenceNumber}`);
  console.log(`  facility  ${session?.facility.name}`);
  console.log(`  session   expires ${session?.expiresAt.toISOString()}`);
  console.log(`  patient   ${patient?.displayNumber} · National ID 39104882`);
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
