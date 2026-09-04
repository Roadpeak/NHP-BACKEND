/**
 * Loads reference data into the database.
 *
 * Reads the vocabularies built in ../nhp-seed, which carry their own
 * validators. Nothing here invents clinical content — if a capability code
 * is wrong, it is wrong in the CSV and `validate.py` is where it gets fixed.
 *
 *   pnpm seed
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where the vocabularies live.
 *
 * `prisma/seed-data` is a vendored copy that ships inside the Docker image.
 * It has to be: the canonical CSVs live in the sibling `nhp-seed` repo,
 * which is not part of this build context and therefore does not exist in
 * a deployed container — production could not seed at all, and came up
 * with no counties, no diagnoses and no triage rules.
 *
 * The sibling repo still wins when it is present, so local development
 * edits data in one place and sees it immediately. `pnpm seed:sync` copies
 * it across; CI checks the two have not drifted apart.
 *
 * SEED_DATA_DIR overrides both, for a deployment that mounts the
 * vocabularies from somewhere else entirely.
 */
const SIBLING_SEED = resolve(__dirname, '../../../../nhp-seed/data');
const VENDORED_SEED = resolve(__dirname, '../prisma/seed-data');
const SEED_DIR =
  process.env.SEED_DATA_DIR ??
  (existsSync(SIBLING_SEED) ? SIBLING_SEED : VENDORED_SEED);

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** Minimal CSV reader — handles quoted fields, which our data does use. */
function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8').trim();
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  const [header, ...body] = rows;
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]?.trim() ?? ''])));
}

// Kenya's counties, with their official numbering. Coordinates are county
// centroids, used as a fallback when a facility has no precise location.
const COUNTIES: Array<[string, string]> = [
  ['001', 'Mombasa'], ['002', 'Kwale'], ['003', 'Kilifi'], ['004', 'Tana River'],
  ['005', 'Lamu'], ['006', 'Taita Taveta'], ['007', 'Garissa'], ['008', 'Wajir'],
  ['009', 'Mandera'], ['010', 'Marsabit'], ['011', 'Isiolo'], ['012', 'Meru'],
  ['013', 'Tharaka Nithi'], ['014', 'Embu'], ['015', 'Kitui'], ['016', 'Machakos'],
  ['017', 'Makueni'], ['018', 'Nyandarua'], ['019', 'Nyeri'], ['020', 'Kirinyaga'],
  ['021', "Murang'a"], ['022', 'Kiambu'], ['023', 'Turkana'], ['024', 'West Pokot'],
  ['025', 'Samburu'], ['026', 'Trans Nzoia'], ['027', 'Uasin Gishu'],
  ['028', 'Elgeyo Marakwet'], ['029', 'Nandi'], ['030', 'Baringo'],
  ['031', 'Laikipia'], ['032', 'Nakuru'], ['033', 'Narok'], ['034', 'Kajiado'],
  ['035', 'Kericho'], ['036', 'Bomet'], ['037', 'Kakamega'], ['038', 'Vihiga'],
  ['039', 'Bungoma'], ['040', 'Busia'], ['041', 'Siaya'], ['042', 'Kisumu'],
  ['043', 'Homa Bay'], ['044', 'Migori'], ['045', 'Kisii'], ['046', 'Nyamira'],
  ['047', 'Nairobi'],
];

async function seedGeography() {
  const idFor = new Map<string, string>();
  for (const [code, name] of COUNTIES) {
    const county = await prisma.county.upsert({
      where: { code },
      create: { code, name },
      update: { name },
    });
    idFor.set(code, county.id);
  }

  /*
   * Kenya's real sub-counties, all 293 of them.
   *
   * Every county used to get a single placeholder named "<County> Central",
   * which meant the registration screens offered one meaningless choice and
   * nobody could record where they actually live. Facilities and people are
   * both scoped to a sub-county, so the placeholder quietly made every
   * address in the system wrong.
   *
   * Keyed on (county, name) rather than a code: sub-counties have no
   * national numbering the way counties do, and inventing one would create
   * an identifier that means nothing outside this database.
   */
  const path = join(SEED_DIR, 'subcounties.csv');
  if (!existsSync(path)) {
    console.warn('  subcounties.csv not found — skipping');
    return { counties: COUNTIES.length, subcounties: 0, unmatched: 0 };
  }

  const rows = readCsv(path);
  let created = 0;
  let unmatched = 0;
  for (const r of rows) {
    const countyId = idFor.get(r.county_code);
    if (!countyId) {
      // A sub-county naming a county that does not exist is a data error,
      // not something to insert against a guessed parent.
      unmatched++;
      continue;
    }
    const existing = await prisma.subCounty.findFirst({
      where: { countyId, name: r.subcounty_name },
      select: { id: true },
    });
    if (!existing) {
      await prisma.subCounty.create({
        data: {
          countyId,
          name: r.subcounty_name,
          kind: (r.kind || 'HEALTH_ADMIN') as 'HEALTH_ADMIN',
        },
      });
      created++;
    }
  }
  return { counties: COUNTIES.length, subcounties: created, unmatched };
}

async function seedCapabilities() {
  const path = join(SEED_DIR, 'capabilities.csv');
  if (!existsSync(path)) {
    console.warn(`  capabilities.csv not found at ${path} — skipping`);
    return { capabilities: 0 };
  }

  const rows = readCsv(path);
  for (const r of rows) {
    const minLevel = r.min_keph_level ? Number.parseInt(r.min_keph_level, 10) : null;
    await prisma.capability.upsert({
      where: { code: r.code },
      create: {
        code: r.code,
        labelEn: r.label_en,
        labelSw: r.label_sw,
        domain: r.domain as 'SERVICE' | 'DIAGNOSTIC' | 'EQUIPMENT' | 'SPECIALTY',
        minKephLevel: Number.isNaN(minLevel) ? null : minLevel,
      },
      update: {
        labelEn: r.label_en,
        labelSw: r.label_sw,
        domain: r.domain as 'SERVICE' | 'DIAGNOSTIC' | 'EQUIPMENT' | 'SPECIALTY',
        minKephLevel: Number.isNaN(minLevel) ? null : minLevel,
      },
    });
  }
  return { capabilities: rows.length };
}

/** Pipe-delimited multi-value CSV field. */
function multi(value: string): string[] {
  return (value || '')
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * ICD-11 chapter, derived from the code's first character(s). Denormalised
 * onto every diagnosis so the Phase 7 rollup can aggregate by chapter
 * without re-deriving it across a national dataset.
 */
function icd11Chapter(code: string): string {
  const head = code.charAt(0).toUpperCase();
  if (head >= '0' && head <= '9') return head.padStart(2, '0');
  return head; // letter-prefixed chapters (e.g. B, C, D, E, F, ...)
}

async function seedDiagnoses() {
  const path = join(SEED_DIR, 'diagnoses.csv');
  if (!existsSync(path)) {
    console.warn(`  diagnoses.csv not found — skipping`);
    return { diagnoses: 0, unreviewed: 0 };
  }

  const rows = readCsv(path);
  let unreviewed = 0;

  for (const r of rows) {
    if (r.review_status !== 'CLINICALLY_REVIEWED') unreviewed++;
    const data = {
      clinicalTitle: r.clinical_title,
      plainEn: r.plain_en,
      plainSw: r.plain_sw,
      synonyms: multi(r.synonyms),
      abbreviations: multi(r.abbreviations),
      bodySystem: r.body_system,
      isNotifiable: r.is_notifiable === 'true',
      sensitivity: r.sensitivity as 'TIER_1_EMERGENCY' | 'TIER_2_GENERAL' | 'TIER_3_RESTRICTED',
      icd11Chapter: icd11Chapter(r.icd11_code),
      reviewStatus: r.review_status,
    };
    await prisma.diagnosisTerm.upsert({
      where: { icd11Code: r.icd11_code },
      create: { icd11Code: r.icd11_code, ...data },
      update: data,
    });
  }
  return { diagnoses: rows.length, unreviewed };
}

async function seedMedications() {
  const path = join(SEED_DIR, 'medications.csv');
  if (!existsSync(path)) {
    console.warn(`  medications.csv not found — skipping`);
    return { medications: 0, controlled: 0 };
  }

  const rows = readCsv(path);
  let controlled = 0;

  for (const r of rows) {
    const isControlled = r.controlled === 'true';
    if (isControlled) controlled++;

    const num = (v: string) => (v && !Number.isNaN(Number(v)) ? Number(v) : null);
    const data = {
      genericName: r.generic_name,
      plainEn: r.plain_en,
      plainSw: r.plain_sw,
      form: r.form,
      strength: r.strength,
      route: r.route as 'ORAL' | 'IV' | 'IM' | 'SC' | 'TOPICAL' | 'INHALED' | 'RECTAL',
      therapeuticClass: r.therapeutic_class,
      minKephLevel: Number.parseInt(r.min_keph_level, 10) || 2,
      adultDose: r.adult_dose,
      adultFreq: r.adult_freq,
      adultDurationDays: num(r.adult_duration_days),
      paedDoseMgPerKg: num(r.paed_dose_mg_per_kg),
      paedDosingMode: r.paed_dosing_mode || 'ADULT_ONLY',
      maxDailyMg: num(r.max_daily_mg),
      allergyClass: r.allergy_class || null,
      pregnancyCategory: r.pregnancy_category,
      renalCaution: r.renal_caution === 'true',
      controlled: isControlled,
      synonyms: multi(r.synonyms),
      reviewStatus: r.review_status,
    };
    await prisma.medicationTerm.upsert({
      where: { kemlCode: r.keml_code },
      create: { kemlCode: r.keml_code, ...data },
      update: data,
    });
  }
  return { medications: rows.length, controlled };
}

/**
 * Paediatric weight bands.
 *
 * Replaced wholesale rather than upserted. A band table is only meaningful
 * as a complete set — the validator proves the bands are contiguous and
 * non-overlapping across the whole drug, and upserting row by row could
 * leave a stale band behind that quietly reintroduces the gap or overlap
 * that check exists to prevent.
 */
async function seedWeightBands() {
  const path = join(SEED_DIR, 'weight_bands.csv');
  if (!existsSync(path)) {
    console.warn(`  weight_bands.csv not found — skipping`);
    return { bands: 0, drugs: 0 };
  }

  const rows = readCsv(path);
  const codes = [...new Set(rows.map((r) => r.keml_code))];

  await prisma.medicationWeightBand.deleteMany({ where: { kemlCode: { in: codes } } });
  for (const r of rows) {
    await prisma.medicationWeightBand.create({
      data: {
        kemlCode: r.keml_code,
        minKg: r.band_min_kg,
        maxKg: r.band_max_kg,
        doseAmount: r.dose_amount,
        doseUnit: r.dose_unit,
        doseForm: r.dose_form,
        frequency: r.frequency,
        durationDays: r.duration_days ? Number(r.duration_days) : null,
        notes: r.notes || null,
      },
    });
  }
  return { bands: rows.length, drugs: codes.length };
}

async function seedAllergyClasses() {
  const path = join(SEED_DIR, 'allergy_classes.csv');
  if (!existsSync(path)) {
    console.warn(`  allergy_classes.csv not found — skipping`);
    return { allergyClasses: 0 };
  }

  const rows = readCsv(path);
  for (const r of rows) {
    const data = {
      labelEn: r.label_en,
      labelSw: r.label_sw,
      crossReactsWith: multi(r.cross_reacts_with),
      severityDefault: r.severity_default as
        | 'MILD'
        | 'MODERATE'
        | 'SEVERE'
        | 'ANAPHYLAXIS',
      alternatives: multi(r.alternatives),
      clinicalNote: r.clinical_note || null,
      reviewStatus: r.review_status,
    };
    await prisma.allergyClassTerm.upsert({
      where: { allergyClass: r.allergy_class },
      create: { allergyClass: r.allergy_class, ...data },
      update: data,
    });
  }
  return { allergyClasses: rows.length };
}

async function seedSymptoms() {
  const path = join(SEED_DIR, 'symptoms.csv');
  if (!existsSync(path)) {
    console.warn('  symptoms.csv not found — skipping');
    return { symptoms: 0, redFlags: 0 };
  }

  const rows = readCsv(path);
  let redFlags = 0;

  for (const r of rows) {
    if (r.kind === 'RED_FLAG') redFlags++;
    const data = {
      labelEn: r.label_en,
      labelSw: r.label_sw,
      questionEn: r.question_en,
      questionSw: r.question_sw,
      bodySystem: r.body_system,
      kind: r.kind,
      severityMarker: r.severity_marker === 'true',
      minAge: Number.parseFloat(r.min_age) || 0,
      maxAge: Number.parseFloat(r.max_age) || 120,
      sex: r.sex || 'ANY',
      durationRelevant: r.duration_relevant === 'true',
      reviewStatus: r.review_status,
    };
    await prisma.symptomTerm.upsert({
      where: { code: r.code },
      create: { code: r.code, ...data },
      update: data,
    });
  }
  return { symptoms: rows.length, redFlags };
}

async function seedTriageRules() {
  const path = join(SEED_DIR, 'triage_rules.csv');
  if (!existsSync(path)) {
    console.warn('  triage_rules.csv not found — skipping');
    return { rules: 0, redFlags: 0, unreviewedRedFlags: [] as string[] };
  }

  const rows = readCsv(path);
  const unreviewedRedFlags: string[] = [];
  let redFlags = 0;

  for (const r of rows) {
    const isRedFlag = r.red_flag === 'true';
    const reviewed = r.reviewed_by && r.reviewed_by.toUpperCase() !== 'UNASSIGNED';

    if (isRedFlag) {
      redFlags++;
      if (!reviewed) unreviewedRedFlags.push(r.rule_id);
    }

    const data = {
      symptoms: multi(r.symptoms),
      ageMin: Number.parseFloat(r.age_min) || 0,
      ageMax: Number.parseFloat(r.age_max) || 120,
      redFlag: isRedFlag,
      urgency: r.urgency,
      requiredCapabilities: multi(r.required_capabilities),
      minKephLevel: Number.parseInt(r.min_keph_level, 10) || 2,
      adviceEn: r.advice_en,
      adviceSw: r.advice_sw,
      reviewedBy: r.reviewed_by || 'UNASSIGNED',
      reviewStatus: r.review_status,
      // THE SAFETY GATE: a red-flag rule with no named clinical reviewer is
      // loaded but INACTIVE. It sends people to emergency departments; it
      // must not fire on a developer's say-so.
      active: !(isRedFlag && !reviewed),
    };

    await prisma.triageRule.upsert({
      where: { ruleId: r.rule_id },
      create: { ruleId: r.rule_id, ...data },
      update: data,
    });
  }

  return { rules: rows.length, redFlags, unreviewedRedFlags };
}

async function main() {
  console.log('seeding reference data ...\n');

  const geo = await seedGeography();
  console.log(`  counties      ${geo.counties}`);
  console.log(`  subcounties   ${geo.subcounties} created`);
  if (geo.unmatched) {
    // Loud, because the rows were silently dropped: a sub-county naming a
    // county that does not exist means the two files have drifted apart.
    console.warn(
      `  WARNING: ${geo.unmatched} subcounty row(s) named an unknown county and were skipped`,
    );
  }

  const caps = await seedCapabilities();
  console.log(`  capabilities  ${caps.capabilities}`);

  const dx = await seedDiagnoses();
  console.log(`  diagnoses     ${dx.diagnoses}`);

  const meds = await seedMedications();
  console.log(`  medications   ${meds.medications}  (${meds.controlled} controlled)`);

  const bands = await seedWeightBands();
  console.log(`  weight bands  ${bands.bands}  (${bands.drugs} drugs)`);

  const allergies = await seedAllergyClasses();
  console.log(`  allergy class ${allergies.allergyClasses}`);

  const sx = await seedSymptoms();
  console.log(`  symptoms      ${sx.symptoms}  (${sx.redFlags} red flags)`);

  const rules = await seedTriageRules();
  const activeRules = rules.rules - rules.unreviewedRedFlags.length;
  console.log(
    `  triage rules  ${rules.rules}  (${rules.redFlags} red flags, ` +
      `${activeRules} active)`,
  );

  if (rules.unreviewedRedFlags.length > 0) {
    console.warn(
      `\n  ${rules.unreviewedRedFlags.length} RED-FLAG RULES ARE INACTIVE — no ` +
        'named clinical reviewer:\n' +
        `    ${rules.unreviewedRedFlags.join(', ')}\n` +
        '  These route people to emergency departments. They stay inactive ' +
        'until a\n  practising clinician signs them off in ' +
        'nhp-seed/data/triage_rules.csv.',
    );
  }

  if (dx.unreviewed > 0) {
    console.warn(
      `\n  WARNING: ${dx.unreviewed}/${dx.diagnoses} diagnoses are not ` +
        'CLINICALLY_REVIEWED. ICD-11 codes were written from knowledge, not ' +
        'extracted from the WHO release — verify before any real patient data.',
    );
  }

  const swahiliMissing = await prisma.capability.count({ where: { labelSw: '' } });
  if (swahiliMissing > 0) {
    console.warn(
      `\n  WARNING: ${swahiliMissing} capabilities have no Swahili label. ` +
        'The citizen-facing picker will show English only.',
    );
  }

  console.log('\nseed complete.');
}

main()
  .catch((err) => {
    console.error('seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
