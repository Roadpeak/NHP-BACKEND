/**
 * Imports the WHO ICD-11 MMS linearization.
 *
 *   pnpm --filter @nhp/api icd11:import            # whole release
 *   pnpm --filter @nhp/api icd11:import --chapter 01
 *   pnpm --filter @nhp/api icd11:import --dry-run
 *
 * WHY THIS EXISTS
 *
 * The 298 curated diagnoses in nhp-seed were written from knowledge rather
 * than extracted from the WHO release, which is why every one of them is
 * flagged NEEDS_CLINICAL_REVIEW. Scaling that approach to ICD-11's ~17,000
 * codes would not produce a national vocabulary; it would produce 17,000
 * unverified codes nobody could ever review, in a system where a wrong code
 * becomes a wrong diagnosis in a permanent, append-only record.
 *
 * So the codes come from WHO, over the API, and are verifiable against it.
 *
 * WHAT WHO DOES NOT SHIP
 *
 * ICD-11 has no Swahili and no plain-language titles. `plain_en` and
 * `plain_sw` are required columns because the citizen timeline shows people
 * their own record in language they actually use — "a long-term condition
 * where your blood sugar is too high", not "Type 2 diabetes mellitus".
 *
 * An imported row therefore carries the clinical title in `plain_en` and an
 * EMPTY `plain_sw`, and is marked `NEEDS_PLAIN_LANGUAGE`. That is not a
 * placeholder to be filled in by a machine later — the seed README is
 * explicit that these must not be machine-translated, because a
 * mistranslated diagnosis shown to a patient is worse than no translation.
 *
 * PRECEDENCE
 *
 * A curated row always wins. The importer never overwrites a code that
 * nhp-seed already carries, because those have had three labels written for
 * them deliberately, and an import must not silently strip the Swahili back
 * out of a row that had it.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOKEN_URL = 'https://icdaccessmanagement.who.int/connect/token';
const API_ROOT = process.env.ICD_API_ROOT ?? 'https://id.who.int';
const RELEASE = process.env.ICD_RELEASE ?? '2024-01';
const LINEARIZATION = 'mms';

const CLIENT_ID = process.env.ICD_CLIENT_ID;
const CLIENT_SECRET = process.env.ICD_CLIENT_SECRET;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const chapterArg = args.indexOf('--chapter');
const ONLY_CHAPTER = chapterArg >= 0 ? args[chapterArg + 1] : null;
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

// ------------------------------------------------------------------ auth

async function getToken(): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'ICD_CLIENT_ID and ICD_CLIENT_SECRET are not set.\n' +
        'Register free at https://icd.who.int/icdapi and put them in apps/api/.env',
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'icdapi_access',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`WHO token request failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

// ------------------------------------------------------------------ fetch

interface IcdEntity {
  '@id': string;
  code?: string;
  title?: { '@value': string };
  definition?: { '@value': string };
  child?: string[];
  classKind?: string;
  indexTerm?: Array<{ label?: { '@value': string } }>;
  synonym?: Array<{ label?: { '@value': string } }>;
}

/**
 * One GET, with retry.
 *
 * WHO rate-limits, and a half-finished vocabulary is worse than a failed
 * import: it looks complete. So a request that keeps failing aborts the run
 * rather than leaving a gap nobody notices.
 */
async function get(url: string, token: string, attempt = 1): Promise<IcdEntity> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'en',
      'API-Version': 'v2',
    },
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`${url}: ${res.status} after 5 attempts`);
    const wait = 2 ** attempt * 500;
    await new Promise((r) => setTimeout(r, wait));
    return get(url, token, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as IcdEntity;
}

// ----------------------------------------------------------------- shape

/** Chapter number -> the body_system vocabulary the seed already uses. */
const CHAPTER_SYSTEM: Record<string, string> = {
  '01': 'infectious', '02': 'oncology', '03': 'haematology', '04': 'immune',
  '05': 'endocrine', '06': 'mental_health', '07': 'sleep', '08': 'neurology',
  '09': 'ophthalmology', '10': 'ent', '11': 'cardiovascular', '12': 'respiratory',
  '13': 'digestive', '14': 'dermatology', '15': 'musculoskeletal',
  '16': 'genitourinary', '17': 'sexual_health', '18': 'maternal',
  '19': 'neonatal', '20': 'congenital', '21': 'symptoms', '22': 'injury',
  '23': 'external_causes', '24': 'health_services', '25': 'special',
  '26': 'traditional_medicine',
};

/**
 * Chapters whose contents are restricted by default.
 *
 * 06 mental health, 17 sexual health. The tier drives who may read the row
 * at all, so it is set from the chapter rather than left to a later pass —
 * defaulting an HIV or mental-health code to general visibility for even
 * one release is a disclosure, not a backlog item.
 */
const RESTRICTED_CHAPTERS = new Set(['06', '17']);

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ------------------------------------------------------------------ walk

interface Row {
  code: string;
  title: string;
  synonyms: string[];
  chapter: string;
  bodySystem: string;
  sensitivity: string;
}

async function walk(
  url: string,
  token: string,
  chapter: string,
  out: Map<string, Row>,
  seen: Set<string>,
  depth = 0,
): Promise<void> {
  if (seen.has(url) || out.size >= LIMIT) return;
  seen.add(url);

  const e = await get(url, token);

  // Only leaf-bearing coded entities become diagnoses. Chapter and block
  // headings have no code and must not be selectable as a diagnosis.
  if (e.code && e.title?.['@value']) {
    const syns = [
      ...(e.synonym ?? []).map((s) => s.label?.['@value']),
      ...(e.indexTerm ?? []).map((s) => s.label?.['@value']),
    ].filter((s): s is string => !!s && s !== e.title?.['@value']);

    out.set(e.code, {
      code: e.code,
      title: e.title['@value'],
      synonyms: [...new Set(syns)].slice(0, 12),
      chapter,
      bodySystem: CHAPTER_SYSTEM[chapter] ?? 'other',
      sensitivity: RESTRICTED_CHAPTERS.has(chapter) ? 'TIER_3_RESTRICTED' : 'TIER_2_GENERAL',
    });

    if (out.size % 250 === 0) {
      process.stdout.write(`\r  fetched ${out.size} codes ...`);
    }
  }

  for (const child of e.child ?? []) {
    await walk(child, token, chapter, out, seen, depth + 1);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`WHO ICD-11 import — release ${RELEASE}, linearization ${LINEARIZATION}`);
  if (DRY_RUN) console.log('DRY RUN — writes a CSV, touches no database\n');

  const token = await getToken();
  const rootUrl = `${API_ROOT}/icd/release/11/${RELEASE}/${LINEARIZATION}`;
  const root = await get(rootUrl, token);

  const chapters = root.child ?? [];
  console.log(`  ${chapters.length} chapters in the release\n`);

  const rows = new Map<string, Row>();
  const seen = new Set<string>();

  for (const chapterUrl of chapters) {
    const ch = await get(chapterUrl, token);
    const num = ch.code ?? chapterUrl.split('/').pop() ?? '??';
    if (ONLY_CHAPTER && num !== ONLY_CHAPTER) continue;
    console.log(`chapter ${num}  ${ch.title?.['@value'] ?? ''}`);
    await walk(chapterUrl, token, num, rows, seen);
    process.stdout.write(`\r  ${rows.size} codes so far\n`);
    if (rows.size >= LIMIT) break;
  }

  console.log(`\nfetched ${rows.size} coded entities`);

  // A curated row always wins: those carry three deliberately written
  // labels, and an import must never strip the Swahili back out.
  const seedDir = resolve(__dirname, '../prisma/seed-data');
  const curatedPath = join(seedDir, 'diagnoses.csv');
  const curated = new Set<string>();
  if (existsSync(curatedPath)) {
    const text = readFileSync(curatedPath, 'utf8').trim().split('\n').slice(1);
    for (const line of text) curated.add(line.split(',')[0]);
    console.log(`  ${curated.size} curated codes will be preserved as they are`);
  }

  const fresh = [...rows.values()].filter((r) => !curated.has(r.code));
  console.log(`  ${fresh.length} new codes to write`);

  const header =
    'icd11_code,clinical_title,plain_en,plain_sw,synonyms,abbreviations,' +
    'body_system,is_notifiable,sensitivity,icd11_chapter,review_status';

  const lines = fresh.map((r) =>
    [
      r.code,
      csvEscape(r.title),
      // The clinical title stands in for plain English until somebody
      // writes a real one. It is at least TRUE, which a generated
      // simplification would not reliably be.
      csvEscape(r.title),
      // Deliberately empty. Machine-translating a diagnosis shown to a
      // patient is worse than showing none.
      '',
      csvEscape(r.synonyms.join('|')),
      '',
      r.bodySystem,
      'false',
      r.sensitivity,
      r.chapter,
      'NEEDS_PLAIN_LANGUAGE',
    ].join(','),
  );

  const outPath = join(seedDir, 'diagnoses_icd11.csv');
  writeFileSync(outPath, `${header}\n${lines.join('\n')}\n`);
  console.log(`\nwrote ${outPath}`);
  console.log(`  ${lines.length} rows, all NEEDS_PLAIN_LANGUAGE with empty plain_sw`);
  console.log(
    '\nThese carry no Swahili and no plain-language title. They are safe to\n' +
      'search and code against; they are NOT safe to show on the citizen\n' +
      'timeline until somebody writes those labels. Do not machine-translate.',
  );
}

main().catch((err) => {
  console.error(`\nimport failed: ${err.message}`);
  process.exit(1);
});
