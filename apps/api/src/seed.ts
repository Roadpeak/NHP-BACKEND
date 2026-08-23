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

async function main() {
  console.log('seeding reference data ...\n');

  const geo = await seedGeography();
  console.log(`  counties      ${geo.counties}`);
  console.log(`  subcounties   ${geo.subcounties} created`);

  const caps = await seedCapabilities();
  console.log(`  capabilities  ${caps.capabilities}`);

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
