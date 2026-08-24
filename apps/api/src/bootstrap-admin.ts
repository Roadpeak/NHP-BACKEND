/**
 * Creates the first Ministry SUPER_ADMIN.
 *
 * Ministry accounts are issued, never self-registered — a national-scope
 * account reaches every county's data, and an open form for that role would
 * be the softest target in the system. Which leaves a bootstrap problem: the
 * first administrator cannot be created by an administrator.
 *
 * This script is that one exception, and it is written to be usable exactly
 * once:
 *
 *   - It REFUSES if any SUPER_ADMIN already exists. The bootstrap is not a
 *     back door to be re-run whenever someone wants another one; the rest
 *     are created from inside the portal by someone who already holds the
 *     role.
 *   - It takes no password. It prints a single-use enrolment instruction and
 *     the administrator sets their own credentials through the normal flow,
 *     so no password ever exists in a shell history or a deploy log.
 *
 *   pnpm ministry:bootstrap -- --phone 0722000000 --id 12345678 \
 *     --given Amina --family Wanjiru --county 047
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

import { hashPassword } from './auth.js';
import { encryptField, blindIndex, normalisePhone } from './crypto.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const existing = await prisma.ministryUser.findFirst({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true },
  });

  if (existing && !process.argv.includes('--force')) {
    console.error(
      'REFUSING: a SUPER_ADMIN already exists.\n\n' +
        'Further Ministry accounts are created from inside the Ministry\n' +
        'portal by someone who already holds the role. This script is the\n' +
        'bootstrap for the first one only.\n\n' +
        'If the first administrator has genuinely been lost, --force will\n' +
        'create another, and that fact belongs in a change record.',
    );
    process.exit(1);
  }

  const phone = arg('phone');
  const nationalId = arg('id');
  const givenName = arg('given');
  const familyName = arg('family');
  const countyCode = arg('county');

  if (!phone || !nationalId || !givenName || !familyName || !countyCode) {
    console.error(
      'Usage: pnpm ministry:bootstrap -- --phone 07XXXXXXXX --id 12345678 \\\n' +
        '         --given Amina --family Wanjiru --county 047',
    );
    process.exit(1);
  }

  const county = await prisma.county.findFirst({ where: { code: countyCode } });
  if (!county) {
    console.error(`No county with code ${countyCode}. Run \`pnpm seed\` first.`);
    process.exit(1);
  }
  const subcounty = await prisma.subCounty.findFirst({ where: { countyId: county.id } });
  if (!subcounty) {
    console.error(`County ${county.name} has no subcounties. Run \`pnpm seed\` first.`);
    process.exit(1);
  }

  // A Ministry user is a person first, so the identity row comes first.
  //
  // `registerAdult` would also create a CITIZEN account on this phone, and
  // `account_one_owner_ck` allows exactly one owner per account — so the
  // administrator's Ministry account could not then use the same number.
  // The person row is created directly and the administrator registers as a
  // citizen separately if they want their own health record, which is the
  // same two-accounts-one-human arrangement every clinician has.
  const displayNumber = `NHP-ADMIN-${randomBytes(3).toString('hex').toUpperCase()}`;
  const person = await prisma.person.create({
    data: {
      displayNumber,
      givenName: encryptField(givenName),
      familyName: encryptField(familyName),
      sexAtBirth: 'FEMALE',
      dateOfBirth: new Date(Date.UTC(1980, 0, 1)),
      countyId: county.id,
      subcountyId: subcounty.id,
      maturity: 'ADULT',
      registeredBy: 'BOOTSTRAP',
      registrationRoute: 'SELF',
      verificationState: 'PENDING',
      identifiers: {
        create: {
          type: 'NATIONAL_ID',
          value: encryptField(nationalId),
          valueIndex: blindIndex(nationalId),
          status: 'ACTIVE',
        },
      },
    },
  });

  const ministryUser = await prisma.ministryUser.create({
    data: {
      personId: person.id,
      role: 'SUPER_ADMIN',
      geoScope: 'NATIONAL',
      mfaRequired: true,
    },
  });

  // A single-use password, printed once. The administrator changes it and
  // enrols a second factor at first sign-in; the server refuses to sign in a
  // privileged account with no MFA, so this alone reaches nothing.
  const temporary = randomBytes(12).toString('base64url');

  await prisma.account.create({
    data: {
      ministryUserId: ministryUser.id,
      phone: encryptField(phone),
      phoneIndex: blindIndex(phone, normalisePhone),
      passwordHash: await hashPassword(temporary),
      status: 'ACTIVE',
    },
  });

  console.log(
    `\nSUPER_ADMIN created for ${givenName} ${familyName}.\n\n` +
      `  phone     ${phone}\n` +
      `  password  ${temporary}\n\n` +
      'This password is shown once and is not stored anywhere readable.\n' +
      'Sign in at /ministry/login, enrol a second factor, and change it.\n' +
      'The server will refuse this account until MFA is enrolled.\n',
  );
}

main()
  .catch((err) => {
    console.error('bootstrap failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
