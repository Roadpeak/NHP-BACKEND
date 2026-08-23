/**
 * PHASE 8 — referrals and loop closure.
 *
 * The scenario from the blueprint: a Level 3 facility refers upward and
 * receives the outcome back. The counter-referral is the part every system
 * forgets, and loop closure is the metric that does not currently exist at
 * national scale in Kenya.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import 'dotenv/config';
import {
  issueReferral,
  respondToReferral,
  recordArrival,
  returnCounterReferral,
  cancelReferral,
  expireStaleReferrals,
  inboundQueue,
  openLoops,
  suggestDestinations,
  closureFunnel,
  closureByFacility,
  emergencyNonArrivals,
  VALIDITY_DAYS,
} from '../src/referral.js';
import { registerAdult } from '../src/identity.js';
import { registerFacility, approveFacility, claimCapability } from '../src/facility.js';
import { registerPractitioner, grantAffiliation, checkIn, checkOut } from '../src/practitioner.js';
import { openEncounter } from '../src/clinical.js';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ctx = { countyId: '', subcountyId: '' };
let seq = 0;

async function wipe() {
  await owner.query('SET session_replication_role = replica');
  for (const t of [
    'counter_referral', 'referral', 'agg_condition_daily', 'recommendation',
    'condition', 'medication', 'allergy', 'encounter', 'access_log',
    'break_glass', 'consent_grant', 'check_in', 'affiliation', 'licence',
    'practitioner', 'facility_capability', 'facility', 'guardianship',
    'identifier', 'account', 'person',
  ]) {
    await owner.query(`DELETE FROM ${t}`);
  }
  await owner.query('SET session_replication_role = origin');
}

beforeAll(async () => {
  if ((await prisma.capability.count()) === 0) {
    throw new Error('Capabilities not loaded. Run `pnpm seed` first.');
  }
  const county = await prisma.county.upsert({
    where: { code: '905' },
    create: { code: '905', name: 'Kisumu (referral fixture)' },
    update: {},
  });
  const sub =
    (await prisma.subCounty.findFirst({ where: { countyId: county.id } })) ??
    (await prisma.subCounty.create({
      data: { countyId: county.id, name: 'Central', kind: 'HEALTH_ADMIN' },
    }));
  ctx.countyId = county.id;
  ctx.subcountyId = sub.id;
});

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

async function makePerson(name = 'Achieng') {
  seq++;
  return registerAdult(prisma, {
    nationalId: `500000${String(seq).padStart(3, '0')}`,
    phone: `07160000${String(seq).padStart(3, '0')}`,
    givenName: name,
    familyName: 'Otieno',
    sexAtBirth: 'FEMALE',
    dateOfBirth: new Date(Date.UTC(1990, 0, 1)),
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    passwordHash: 'argon2id$dummy',
  });
}

/** A facility with capabilities, plus a checked-in doctor working there. */
async function makeSite(name: string, kephLevel: number, capabilities: string[]) {
  const facility = await registerFacility(prisma, {
    name,
    kephLevel,
    ownership: 'PUBLIC_MOH',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    locality: 'Milimani',
    latitude: -0.0917,
    longitude: 34.768,
    is24Hour: true,
  });
  await approveFacility(prisma, facility.id, 'ministry-1');
  for (const c of capabilities) {
    await claimCapability(prisma, { facilityId: facility.id, capabilityCode: c });
  }

  const person = await makePerson('Clinician');
  seq++;
  const { practitioner } = await registerPractitioner(prisma, {
    personId: person.id,
    cadre: 'DOCTOR',
    countyId: ctx.countyId,
    subcountyId: ctx.subcountyId,
    licenceNumber: `KMPDC/2026/R${String(seq).padStart(3, '0')}`,
  });
  await grantAffiliation(prisma, {
    practitionerId: practitioner.id,
    facilityId: facility.id,
    grantedBy: 'ministry-1',
    grantedByKind: 'MINISTRY',
  });
  await checkIn(prisma, { practitionerId: practitioner.id, facilityId: facility.id });

  return { facility, practitioner };
}

const window = () => ({
  from: new Date(Date.now() - 86_400_000),
  to: new Date(Date.now() + 86_400_000),
});

// =====================================================================

describe('the referral loop', () => {
  it('THE FULL LOOP — refer upward, patient arrives, outcome comes back', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL', 'LAB_BASIC']);
    const referral_hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'SURGERY_GENERAL',
      'THEATRE',
      'BLOOD_BANK',
    ]);
    const patient = await makePerson('Patient');

    // 1. The health centre sees the patient and refers upward.
    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'severe abdominal pain, rigid abdomen',
    });

    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: encounter.id,
      toFacilityId: referral_hospital.facility.id,
      urgency: 'EMERGENCY',
      reason: 'Suspected perforation, needs urgent laparotomy',
      requiredCapabilities: ['SURGERY_GENERAL', 'THEATRE'],
    });
    expect(referral.status).toBe('ISSUED');

    // The originating encounter records the disposition.
    const origin = await prisma.encounter.findUnique({ where: { id: encounter.id } });
    expect(origin?.disposition).toBe('REFERRED');
    expect(origin?.referralId).toBe(referral.id);

    // 2. The referral hospital accepts.
    const accepted = await respondToReferral(prisma, {
      referralId: referral.id,
      practitionerId: referral_hospital.practitioner.id,
      accept: true,
    });
    expect(accepted.status).toBe('ACCEPTED');

    // 3. The patient actually arrives — the step that proves this was more
    //    than a piece of paper.
    const arrivalEncounter = await openEncounter(prisma, {
      practitionerId: referral_hospital.practitioner.id,
      personId: patient.id,
      kind: 'EMERGENCY',
      chiefComplaint: 'referred from Migosi with suspected perforation',
    });
    const arrived = await recordArrival(prisma, {
      referralId: referral.id,
      practitionerId: referral_hospital.practitioner.id,
      arrivalEncounterId: arrivalEncounter.id,
    });
    expect(arrived.status).toBe('ARRIVED');

    // 4. The loop closes: the referring clinician learns what happened.
    const counter = await returnCounterReferral(prisma, {
      referralId: referral.id,
      practitionerId: referral_hospital.practitioner.id,
      summary: 'Laparotomy performed, perforated appendix. Recovering well.',
      outcomeCode: '1F41.0',
      followUpPlan: 'Review wound at Migosi in 7 days',
    });
    expect(counter.summary).toMatch(/laparotomy/i);

    const closed = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(closed?.status).toBe('COMPLETED');

    // And the referring clinician has no open loop left.
    expect(await openLoops(prisma, centre.practitioner.id)).toHaveLength(0);
  });

  it('refuses a referral to a facility that cannot do the work', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const dispensary = await makeSite('Nyalenda Dispensary', 2, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');

    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'needs surgery',
    });

    // Sending someone to a facility that cannot treat them is the exact
    // time-wasting the whole system exists to prevent.
    await expect(
      issueReferral(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        fromEncounterId: encounter.id,
        toFacilityId: dispensary.facility.id,
        urgency: 'URGENT_24H',
        reason: 'Needs an operation',
        requiredCapabilities: ['SURGERY_GENERAL', 'THEATRE'],
      }),
    ).rejects.toThrow(/does not offer|wasted journey/i);
  });

  it('refuses a self-referral', async () => {
    const site = await makeSite('Kisumu County Referral', 5, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');
    const encounter = await openEncounter(prisma, {
      practitionerId: site.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'fever',
    });

    await expect(
      issueReferral(prisma, {
        practitionerId: site.practitioner.id,
        personId: patient.id,
        fromEncounterId: encounter.id,
        toFacilityId: site.facility.id,
        urgency: 'ROUTINE',
        reason: 'second opinion',
        requiredCapabilities: [],
      }),
    ).rejects.toThrow(/already in/i);
  });

  it('requires a decline reason', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'SURGERY_GENERAL',
      'THEATRE',
    ]);
    const patient = await makePerson('Patient');
    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'needs surgery',
    });
    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: encounter.id,
      toFacilityId: hospital.facility.id,
      urgency: 'SOON_7D',
      reason: 'elective hernia repair',
      requiredCapabilities: ['SURGERY_GENERAL'],
    });

    // The referring clinician needs to know where else to send the patient.
    await expect(
      respondToReferral(prisma, {
        referralId: referral.id,
        practitionerId: hospital.practitioner.id,
        accept: false,
      }),
    ).rejects.toThrow(/requires a reason/i);

    const declined = await respondToReferral(prisma, {
      referralId: referral.id,
      practitionerId: hospital.practitioner.id,
      accept: false,
      declineReason: 'Theatre list full for six weeks; try Jaramogi',
    });
    expect(declined.status).toBe('DECLINED');
    expect(declined.declineReason).toMatch(/theatre list full/i);
  });

  it('refuses to close a loop before the patient arrived', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'SURGERY_GENERAL',
    ]);
    const patient = await makePerson('Patient');
    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'needs surgery',
    });
    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: encounter.id,
      toFacilityId: hospital.facility.id,
      urgency: 'SOON_7D',
      reason: 'elective repair',
      requiredCapabilities: ['SURGERY_GENERAL'],
    });

    await expect(
      returnCounterReferral(prisma, {
        referralId: referral.id,
        practitionerId: hospital.practitioner.id,
        summary: 'Patient seen and discharged',
      }),
    ).rejects.toThrow(/must have arrived/i);
  });

  it('requires a real summary on the counter-referral', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');

    const e1 = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'referral',
    });
    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: e1.id,
      toFacilityId: hospital.facility.id,
      urgency: 'ROUTINE',
      reason: 'review',
      requiredCapabilities: [],
    });
    const e2 = await openEncounter(prisma, {
      practitionerId: hospital.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'referred',
    });
    await recordArrival(prisma, {
      referralId: referral.id,
      practitionerId: hospital.practitioner.id,
      arrivalEncounterId: e2.id,
    });

    // An empty summary closes the loop on paper without telling the
    // referring clinician anything.
    await expect(
      returnCounterReferral(prisma, {
        referralId: referral.id,
        practitionerId: hospital.practitioner.id,
        summary: '   ',
      }),
    ).rejects.toThrow(/needs a summary/i);
  });
});

describe('open referrals', () => {
  it('can be picked up by any capable facility', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'DIALYSIS',
    ]);
    const patient = await makePerson('Patient');

    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'renal failure',
    });

    // No destination named — any facility that can dialyse.
    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: encounter.id,
      urgency: 'URGENT_24H',
      reason: 'Needs dialysis',
      requiredCapabilities: ['DIALYSIS'],
    });
    expect(referral.toFacilityId).toBeNull();

    // It shows in the capable facility's inbound queue...
    const queue = await inboundQueue(prisma, hospital.facility.id);
    expect(queue.map((r) => r.id)).toContain(referral.id);

    // ...and accepting it directs the referral there.
    const accepted = await respondToReferral(prisma, {
      referralId: referral.id,
      practitionerId: hospital.practitioner.id,
      accept: true,
    });
    expect(accepted.toFacilityId).toBe(hospital.facility.id);
  });

  it('suggests destinations that can actually help', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'CT_SCAN',
    ]);
    await makeSite('Nyalenda Dispensary', 2, ['OPD_GENERAL']);

    const suggestions = await suggestDestinations(prisma, {
      requiredCapabilities: ['CT_SCAN'],
      excludeFacilityId: centre.facility.id,
    });
    expect(suggestions.map((s) => s.id)).toEqual([hospital.facility.id]);
  });
});

describe('the inbound queue', () => {
  it('puts emergencies first, then oldest', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, [
      'OPD_GENERAL',
      'SURGERY_GENERAL',
    ]);

    const made: Array<{ id: string; urgency: string }> = [];
    for (const urgency of ['ROUTINE', 'EMERGENCY', 'SOON_7D'] as const) {
      const patient = await makePerson('Patient');
      const e = await openEncounter(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'referral',
      });
      const r = await issueReferral(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        fromEncounterId: e.id,
        toFacilityId: hospital.facility.id,
        urgency,
        reason: `${urgency} case`,
        requiredCapabilities: ['SURGERY_GENERAL'],
      });
      made.push({ id: r.id, urgency });
    }

    const queue = await inboundQueue(prisma, hospital.facility.id);
    expect(queue[0].urgency).toBe('EMERGENCY');
    expect(queue[queue.length - 1].urgency).toBe('ROUTINE');
  });
});

describe('expiry', () => {
  it('gives an emergency referral a much shorter life than a routine one', () => {
    expect(VALIDITY_DAYS.EMERGENCY).toBe(1);
    expect(VALIDITY_DAYS.ROUTINE).toBe(90);
  });

  it('lapses referrals nobody acted on', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');
    const e = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'referral',
    });
    const referral = await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: e.id,
      toFacilityId: hospital.facility.id,
      urgency: 'EMERGENCY',
      reason: 'urgent case nobody picked up',
      requiredCapabilities: [],
    });

    // An emergency referral still 'issued' two days later did not succeed.
    const twoDaysOn = new Date(Date.now() + 2 * 86_400_000);
    const result = await expireStaleReferrals(prisma, twoDaysOn);
    expect(result.expired).toBe(1);

    const after = await prisma.referral.findUnique({ where: { id: referral.id } });
    expect(after?.status).toBe('EXPIRED');
  });
});

describe('loop closure — the metric', () => {
  /** Issues n referrals and advances them to the given stage. */
  async function buildFunnel(stages: Array<'ISSUED' | 'ARRIVED' | 'COMPLETED' | 'DECLINED'>) {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, ['OPD_GENERAL']);

    for (const stage of stages) {
      const patient = await makePerson('Patient');
      const e1 = await openEncounter(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'referral',
      });
      const referral = await issueReferral(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        fromEncounterId: e1.id,
        toFacilityId: hospital.facility.id,
        urgency: 'SOON_7D',
        reason: 'review',
        requiredCapabilities: [],
      });

      if (stage === 'ISSUED') continue;

      if (stage === 'DECLINED') {
        await respondToReferral(prisma, {
          referralId: referral.id,
          practitionerId: hospital.practitioner.id,
          accept: false,
          declineReason: 'no capacity this month',
        });
        continue;
      }

      const e2 = await openEncounter(prisma, {
        practitionerId: hospital.practitioner.id,
        personId: patient.id,
        kind: 'OUTPATIENT',
        chiefComplaint: 'referred',
      });
      await recordArrival(prisma, {
        referralId: referral.id,
        practitionerId: hospital.practitioner.id,
        arrivalEncounterId: e2.id,
      });

      if (stage === 'COMPLETED') {
        await returnCounterReferral(prisma, {
          referralId: referral.id,
          practitionerId: hospital.practitioner.id,
          summary: 'Seen, treated, discharged',
        });
      }
    }

    return { centre, hospital };
  }

  it('THE PITCH NUMBER — reports a funnel, not a single figure', async () => {
    await buildFunnel(['COMPLETED', 'COMPLETED', 'ARRIVED', 'ISSUED', 'DECLINED']);

    const funnel = await closureFunnel(prisma, window());
    expect(funnel.issued).toBe(5);
    expect(funnel.declined).toBe(1);
    expect(funnel.arrived).toBe(3); // 2 completed + 1 arrived
    expect(funnel.completed).toBe(2);

    // "40% closure" alone hides whether patients never arrived or arrived
    // and were never reported on — completely different problems.
    expect(funnel.arrivalRatePercent).toBe(60);
    expect(funnel.closureRatePercent).toBe(40);
  });

  it('identifies facilities that receive patients but never report back', async () => {
    const { hospital } = await buildFunnel(['ARRIVED', 'ARRIVED', 'COMPLETED']);

    const byFacility = await closureByFacility(prisma, window());
    const row = byFacility.find((r) => r.facilityId === hospital.facility.id);
    expect(row?.received).toBe(3);
    expect(row?.closed).toBe(1);
    expect(row?.closureRatePercent).toBeCloseTo(33.3, 0);
  });

  it('THE SERIOUS FAILURE — emergency referrals where nobody arrived', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const hospital = await makeSite('Kisumu County Referral', 5, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');

    const e = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'EMERGENCY',
      chiefComplaint: 'collapse',
    });
    await issueReferral(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      fromEncounterId: e.id,
      toFacilityId: hospital.facility.id,
      urgency: 'EMERGENCY',
      reason: 'Suspected stroke, needs a scanner',
      requiredCapabilities: [],
    });

    // Someone was sent urgently and there is no record they got there.
    const missing = await emergencyNonArrivals(prisma, window());
    expect(missing).toHaveLength(1);
    expect(missing[0].reason).toMatch(/stroke/i);
  });

  it('reports zeroes rather than dividing by zero', async () => {
    const funnel = await closureFunnel(prisma, window());
    expect(funnel.issued).toBe(0);
    expect(funnel.closureRatePercent).toBe(0);
  });
});

describe('the write gate applies to referrals too', () => {
  it('refuses to issue one without an open session', async () => {
    const centre = await makeSite('Migosi Health Centre', 3, ['OPD_GENERAL']);
    const patient = await makePerson('Patient');
    const encounter = await openEncounter(prisma, {
      practitionerId: centre.practitioner.id,
      personId: patient.id,
      kind: 'OUTPATIENT',
      chiefComplaint: 'referral',
    });

    await checkOut(prisma, centre.practitioner.id);

    await expect(
      issueReferral(prisma, {
        practitionerId: centre.practitioner.id,
        personId: patient.id,
        fromEncounterId: encounter.id,
        urgency: 'ROUTINE',
        reason: 'review',
        requiredCapabilities: [],
      }),
    ).rejects.toThrow(/check in to a facility/i);
  });
});
