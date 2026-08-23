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
const SEED_DIR = resolve(__dirname, '../../../../nhp-seed/data');

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
  let created = 0;
  for (const [code, name] of COUNTIES) {
    const county = await prisma.county.upsert({
      where: { code },
      create: { code, name },
      update: { name },
    });
    // One placeholder health sub-county per county so facilities can be
    // registered before the full 300+ list is loaded.
    const existing = await prisma.subCounty.findFirst({
      where: { countyId: county.id, name: `${name} Central` },
    });
    if (!existing) {
      await prisma.subCounty.create({
        data: { countyId: county.id, name: `${name} Central`, kind: 'HEALTH_ADMIN' },
      });
      created++;
    }
  }
  return { counties: COUNTIES.length, subcounties: created };
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

async function main() {
  console.log('seeding reference data ...\n');

  const geo = await seedGeography();
  console.log(`  counties      ${geo.counties}`);
  console.log(`  subcounties   ${geo.subcounties} created`);

  const caps = await seedCapabilities();
  console.log(`  capabilities  ${caps.capabilities}`);

  const dx = await seedDiagnoses();
  console.log(`  diagnoses     ${dx.diagnoses}`);

  const meds = await seedMedications();
  console.log(`  medications   ${meds.medications}  (${meds.controlled} controlled)`);

  const allergies = await seedAllergyClasses();
  console.log(`  allergy class ${allergies.allergyClasses}`);

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
