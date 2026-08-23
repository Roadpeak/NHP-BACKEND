# NHP — National Health Portal

A longitudinal health record and care-routing system for Kenya.

**All ten phases complete.** 225 passing tests against a real PostgreSQL —
the guarantees are proven, not asserted.

## Quick start

```bash
pnpm install
pnpm db:up          # Postgres 16 + PostGIS on localhost:5434
pnpm migrate        # push the Prisma schema
pnpm harden         # apply the guarantees (roles, triggers, constraints)
pnpm seed           # reference data from ../nhp-seed
pnpm test           # prove the refusals
```

`pnpm setup` runs all of the above in order.

### Running the API

```bash
pnpm seed:demo      # one facility, one checked-in doctor, one patient
pnpm serve          # http://localhost:4400/api/v1
```

`seed:demo` prints working credentials and a TOTP secret. Sign in with
`POST /api/v1/auth/login`, complete the second factor, and use the returned
bearer token.

`pnpm test` wipes the demo data — re-run `pnpm seed:demo` afterwards.

Port 4400 is deliberate — 4000 is taken by another project on this machine.

Port 5434 is deliberate — 5433 is already taken by another project on this
machine.

## Layout

```
apps/api/
  prisma/schema.prisma      structure — 25 models, 40 enums
  prisma/sql/harden.sql     the guarantees — roles, triggers, constraints
  src/harden.ts             applies harden.sql, reports what landed
  test/refusals.test.ts     Phase 0's exit criterion
infra/docker-compose.yml    Postgres + PostGIS
```

## The architecture in one paragraph

Prisma owns table *structure*. `harden.sql` owns the *guarantees*, because
application code can be bypassed by a bug, a migration script, or a console
session — and a national health record cannot depend on developer discipline.
Clinical tables are append-only at the grant level and again at the trigger
level. Every clinical row must be written inside an open check-in session, at
the facility that session names, by the practitioner who holds it, citing a
licence that was valid at that moment. All four are enforced by one trigger.

## Database roles

The role separation is the whole security model.

| Role | Holds | Deliberately lacks |
|---|---|---|
| `nhp_owner` | superuser | — used only for migrations and hardening |
| `nhp_app` | the API's connection | UPDATE/DELETE on clinical tables |
| `nhp_audit_writer` | INSERT on `access_log` | everything else |
| `nhp_auditor` | SELECT on audit tables | any clinical content |
| `nhp_analyst` | SELECT on aggregates | **any grant on any clinical table** |

That last row is the one to defend. If `nhp_analyst` ever gains a clinical
grant, the four-role Ministry separation becomes decorative and the Data
Protection Act position collapses. A test asserts it holds zero.

## The twelve refusals

Each performs a forbidden operation and asserts the *database* rejects it —
not that the application declines to try.

| # | Refusal | Mechanism |
|---|---|---|
| 1 | UPDATE on a clinical row | revoked grant + trigger |
| 2 | DELETE on a clinical row | revoked grant + trigger |
| 3 | clinical row with empty attribution | CHECK constraint |
| 4 | allergy not marked Tier 1 | CHECK constraint |
| 5 | clinical write with no open check-in | trigger |
| 6 | clinical write on an expired licence | trigger |
| 7 | check-in to an unaffiliated facility | trigger |
| 8 | two ACTIVE identifiers, same value | partial unique index |
| 9 | DELETE on the audit log | revoked grant + trigger |
| 10 | consent grant with no expiry | NOT NULL + CHECK |
| 11 | merge approved by one person | CHECK constraint |
| 12 | Tier 3 aggregate below county level | CHECK constraint |
| 13 | UPDATE on break_glass | revoked grant + trigger |
| 14 | DELETE on break_glass | revoked grant + trigger |

`observation` and `procedure` are append-only on the same terms — revoked
grants, the reject trigger, the check-in gate, and the attribution
constraint all extend to them.

Plus eleven positive-path tests proving the system still *works* — a
legitimate write succeeds, a correction supersedes without editing, a
superseded duplicate identifier is allowed, a two-approver merge passes.

### The one exception, and how it is contained

A correction must mark its predecessor superseded, which is technically an
UPDATE. Rather than granting UPDATE back, `nhp_supersede()` is a
`SECURITY DEFINER` function that sets `superseded_at` and nothing else. The
app role holds EXECUTE on that function and no direct UPDATE grant. A test
proves the original row's content is untouched afterwards.

### Self-access

A practitioner opening their own record is the most common insider-abuse
pattern in health systems. A trigger rewrites any such `access_log` row to
`DENIED_SELF_ACCESS` regardless of what the application claimed — so an
attempt to log it as GRANTED records the truth instead.

## Two bugs the tests caught

Worth recording, since both would have surfaced in production:

**`nhp_supersede` took a `uuid` parameter.** Prisma stores ids as `text`
columns, so every correction would have failed with *"operator does not
exist: text = uuid"*. The same mismatch existed in the break-glass review
function and the self-access trigger.

**Trigger ordering.** The check-in gate fires before CHECK constraints, so
an empty `recorded_by` is caught by "does not hold check-in" rather than the
attribution constraint. The test now proves *both* layers independently —
the constraint is verified by disabling triggers and asserting it still
refuses.

## Status

- [x] **Phase 0** — foundation, schema, roles, triggers, refusal suite
- [x] **Phase 1** — identity: registration, guardianship, promotion at 18
- [x] **Phase 2** — facilities: registry, capabilities, KEPH levels
- [x] **Phase 3** — clinicians: licences, affiliation, check-in
- [x] **Phase 4** — clinical core: encounters, coded diagnoses, prescribing
- [x] **Phase 5** — consent, tiered access, break-glass
- [x] **Phase 6** — triage: symptom rules, facility recommendation
- [x] **Phase 7** — Ministry analytics, suppression, surveillance
- [x] **Phase 8** — referrals and loop closure
- [x] **Phase 9** — hardening: offline sync, merge, rate limits, MFA

## Authentication

Argon2id passwords, 15-minute access tokens, rotating refresh tokens, and
TOTP second factors. What the tests pin down:

**Enumeration** — an unknown phone number and a wrong password return the
same error with the same wording and comparable timing, so login cannot be
used to discover who holds an account.

**MFA is enforced server-side.** A clinical account with no second factor
*cannot sign in at all* — `MFA_ENROLMENT_REQUIRED`. A client that "forgets"
to prompt simply never receives a token. And a clinical token whose factor
was never presented is refused by `requirePractitioner`, so holding a
clinical identity is not sufficient on its own.

**Refresh-token theft is detectable.** Tokens rotate on every use and are
stored hashed. Replaying an already-used token revokes the entire family —
logging out the thief *and* the real user, which is correct: being logged
out is the only signal the real user gets that their session was stolen.

**MFA state does not survive a refresh** for privileged accounts. A 30-day
refresh token must not silently confer a second factor.

### The refresh cookie

The refresh token never appears in a response body. It is set as an
**httpOnly, SameSite=Strict cookie scoped to `/api/v1/auth`**, so no script
can read it and it is not attached to ordinary API calls.

Because a cookie is sent automatically, the refresh endpoint also demands a
**double-submit CSRF token**: a second, deliberately *readable* cookie that
the page must echo in an `x-csrf-token` header. A cross-origin page can
cause the refresh cookie to be sent; it cannot read the CSRF one, so it
cannot produce the header.

A restored session is authenticated but **not** MFA-satisfied, so a
clinician returning after a reload is asked for their second factor again.

### SMS second factor

**SMS is the primary channel, not a fallback.** Authenticator apps assume a
smartphone and a working app store; a clinical officer at a Level 3 facility
has neither, and a TOTP-only system excludes exactly the staff who most need
including. Africa's Talking is the gateway, per the blueprint.

| Rule | Why |
|---|---|
| No message carries health content | Phones are shared in Kenyan households; a lock-screen preview is a disclosure |
| Login sending is never awaited | A gateway outage must not hold a sign-in open |
| **Enrolment** sending IS awaited | If the handset is unreachable the clinician must find out now, not when they are locked out |
| Break-glass sending is never awaited | A clinician treating an unconscious patient must not wait on an SMS gateway |
| Console provider refuses to run in production | A code printed to a log is a code never sent |

Break-glass now notifies the patient: it names the facility and time so they
can query it, and says nothing about what was opened.

## Phase 1 — identity

`person` holds no external identifier. National ID, birth certificate and
phone live in `identifier` as attached rows keyed to an immutable internal
id. That is what makes promotion at 18 an INSERT rather than a migration.

Identifiers are encrypted (AES-256-GCM) with a blind index —
`HMAC(pepper, normalise(value))` — so a facility can search by National ID
without the plaintext sitting in a queryable column. Normalisation is
security-critical: `39104882`, ` 39-104-882 ` and `+254712345678` vs
`0712345678` must collapse to one index, or the same person registers twice
and their history splits.

19 tests, including the one that matters:

**`THE CRITICAL TEST — clinical history survives promotion untouched`**
registers a child, writes a real encounter and diagnosis through the Phase 0
check-in gate, promotes them at 18, then asserts the person id is unchanged,
both clinical rows still resolve, their new National ID finds the same
record, and the guardian can no longer see it.

Guardianship supports multiple guardians per child — searching either
parent's ID surfaces the dependant. Promotion runs in two stages so care is
never interrupted on a birthday: `flagDueForPromotion` marks the record
`PENDING_PROMOTION` while leaving guardian access intact, and
`finalisePromotions` closes that access only after a 90-day grace period.

## Phase 2 — facilities

Kenya's six-level KEPH tiering (2 dispensary … 6 national referral). Level 1
is community units, which have no physical facility and cannot be registered.
Facilities register as `PENDING`; only the Ministry can activate one, which
is what makes the registry a registry rather than a directory.

Capabilities come from a controlled vocabulary — 65 codes seeded from
`../nhp-seed`, with Swahili labels and a `minKephLevel` sanity bound. A
dispensary claiming an ICU is refused, because letting it through would send
critically ill patients to a building with no oxygen.

**The stale-claim problem is the real work here.** A facility ticks "CT
scanner" at registration; eighteen months later it is broken and nobody
updated the profile. So a claim has an age:

| Age | Behaviour |
|---|---|
| < 90 days | `FRESH` — full confidence |
| 90–365 days | `STALE` — still matches, flagged, downranked |
| > 365 days | `EXPIRED` — stops matching entirely |

`findFacilities` ranks by confidence first, then distance, then the *lowest*
adequate KEPH level — deliberately not "biggest hospital first", since
sending simple cases to Level 6 referrals is exactly what clogs Kenyan
hospitals. A test proves a fresh distant claim beats a stale near one.

`findWithWidening` escalates subcounty → county → national when nothing
local qualifies, and reports how far it had to reach so the citizen can be
told plainly why they are being sent further.

## Phase 3 — clinicians

Three layers, all required before a clinical write:

**Affiliation** — a durable clinician↔facility link, never self-declared.
Who may grant it is not a detail: public facilities are staffed by the
Ministry, private facilities manage their own. A private admin adding staff
to a public hospital would be a posting nobody authorised, so it is refused.

**Check-in** — a 16-hour shift, one open session at a time. A clinician
cannot be on duty at two facilities at once; allowing it would make
attribution ambiguous.

**Verification** — six Kenyan regulators (KMPDC, NCK, COC, PPB, KMLTTB,
KNDI) behind a pluggable `VerificationProvider`. The mock models real failure
modes — not found, expired, suspended, struck off, register unreachable —
because code that has only seen success handles none of them. A regulator
being down leaves the account `PENDING`; it never silently activates.

Cadres without a statutory register (psychologists, community health
workers) are not forced to invent a licence number.

`canWriteClinical()` checks the same four conditions the Phase 0 trigger
enforces, so the UI can explain the problem instead of surfacing a database
error. A test asserts the two agree: when the gate says yes, the write
actually succeeds.

### The session ceiling

Extensions are available only in the final hour, and clamp to 24 hours from
check-in — the same bound `checkin_window_ck` enforces. Without the clamp,
rolling extensions would turn a shift into a permanent session and "checked
in" would stop meaning anything. The database caught this: my first
implementation added 16 hours to an already-15-hour-old session and the
constraint refused the write.

## Phase 4 — clinical core

The full loop works: open an encounter, record an ICD-11 coded diagnosis,
prescribe against the KEML formulary, see it on the patient timeline —
every row stamped with who wrote it, where, during which shift, citing
which licence.

Vocabularies load from `../nhp-seed`: 50 diagnoses, 64 medicines, 22 allergy
classes. Diagnosis search matches the wireframe spec — `mal` returns
falciparum malaria first, `pressure` returns hypertension, `kisukari`
returns diabetes, and typing a code directly works for clinicians who know
them.

**Free text is refused.** `recordDiagnosis` rejects anything not in the
vocabulary, because "malaria", "Malaria" and "susp. malaria" as free text
would become three diseases and the national analytics would be worthless.
`icd11Title` is frozen at write time, since ICD-11 is revised and a record
must show what the clinician actually selected.

### The contraindication interrupt

Fires at drug selection, not on submit. Catches same-class allergies *and*
cross-reactions — a penicillin-allergic patient is blocked from ceftriaxone,
not just amoxicillin. Every suggested alternative is re-checked against the
same patient, so nothing unsafe is offered on the second hop.

Override is always available, because blocking a clinician outright is how
people learn to route around a system. It costs a typed reason, and it is
recorded against the prescriber.

### Corrections

`amendDiagnosis` inserts a new version pointing at its predecessor, then
marks the original superseded through `nhp_supersede()` — the only permitted
UPDATE path. Both versions survive; the timeline shows the current one; an
auditor sees who changed what and why.

## Phase 5 — consent and break-glass

Three tiers. Tier 1 (allergies, blood group) is never gated — friction there
kills people. Tier 2 is visible but logged. Tier 3 (HIV, mental health,
reproductive health, substance use, GBV) needs consent or break-glass.

**The withholding rule** is the one easiest to get wrong: a clinician is
told restricted records *exist* without being shown them. Hiding their
existence means the clinician never knows to ask the patient, which defeats
the clinical purpose of the tier entirely.

Consent is per-category, not all-or-nothing — someone may disclose a mental
health history and not their HIV status. Every grant expires; the database
caps it at a year.

Break-glass grants access **immediately** — an unconscious patient cannot
consent and a clinician must never wait for approval. What makes it
expensive is everything after: a 20-character justification, a 4-hour
window, automatic entry into the auditor queue, a patient notification, and
the facility's rate on its own dashboard. A clinician cannot break-glass
their own record.

`denialAnomalies` is the fraud signal from the blueprint: a clinician who
searches forty IDs and is denied on thirty-eight is far more interesting
than anyone who was granted access. Most systems log only success.

## Phase 6 — triage

Deterministic and explainable. Every recommendation traces to a named rule
at a known version, so when one is questioned later you can reconstruct
exactly what fired. No model sits in this decision path.

**The safety gate carries all the way from CSV to runtime.** All 19
red-flag rules ship with `reviewed_by=UNASSIGNED`, load into the database
as `active=false`, and cannot fire. `pnpm seed` prints them by name. They
stay inactive until a practising clinician signs them off — these rules
route people to emergency departments and must not go live on a developer's
say-so.

When a gated rule *would* have matched, the result reports it in
`inactiveRulesMatched` rather than swallowing the gap. A silently missing
red flag is the dangerous failure mode.

**A red flag bypasses ranking entirely.** Back pain reported alongside
convulsions routes to an emergency department, not a physiotherapist — a
test asserts exactly that. Rules require ALL their symptoms, so chest pain
alone does not fire the chest-pain-plus-breathlessness rule.

`orphanedRedFlags` reports red-flag symptoms with no active rule behind
them — the same invariant that caught nine real safety holes when the seed
data was built.

Every recommendation carries a disclaimer in English and Swahili: guidance
on where to seek care, not a diagnosis.

## Phase 7 — Ministry analytics

The ANALYST role holds no grant on any clinical table — a test asserts
`permission denied` on all seven. It reads only aggregates that never held a
`person_id`.

**Suppression is stored, not rendered.** A suppressed row carries
`case_count = 0`, so no endpoint, export or raw SQL query can serve the true
number by accident. A test connects as the analyst and confirms it.

**Complementary suppression** is the part most implementations miss. Hiding
one small cell is not enough when a published total lets anyone recover it
by subtraction, so whenever a group has exactly one hidden cell, the
smallest survivor is hidden too — purely as cover. Verified adversarially:

```
published total : 142
visible cells   : a=100
hidden cells    : 2  (COMPLEMENTARY, PRIMARY)
residual        : 42 spread across 2 hidden cells
SAFE: residual cannot be attributed to any single cell
```

Restricted conditions never aggregate below county level, enforced by a
database CHECK as well as the rollup — small geography plus stigmatised
condition is where re-identification actually happens.

Completeness travels with every count: a rise in cases and a rise in
*reporting* are indistinguishable without it.

Also here: workforce derived from actual check-ins rather than an
establishment list, care gaps (chronic patients lost to follow-up), and
notifiable-disease signals raised automatically — manual reporting is
under-complied with everywhere, which is why it cannot depend on a clinician
remembering.

## Phase 8 — referrals

Issued → accepted → arrived → **outcome returned**. That last step is the
counter-referral, the part every system forgets and the part clinicians
complain about most: without it a referral is a one-way message, not care.

A referral is refused if the destination cannot do the work — sending
someone to a facility that cannot treat them is the exact time-wasting NHP
exists to prevent. Declining requires a reason, because the referring
clinician needs to know where else to send the patient. Open referrals
(no destination named) can be picked up by any capable facility.

Validity scales with urgency: an emergency referral lapses in a day, a
routine one in ninety. An emergency still marked "issued" a week later did
not succeed, and pretending otherwise hides the failure in the statistics.

### Loop closure — the pitch number

Reported as a **funnel**, not a single figure:

```
issued 5 · declined 1 · arrived 3 · completed 2
arrival rate 60%  ·  closure rate 40%
```

"40% closure" alone hides whether patients never arrived or arrived and were
never reported on — completely different problems with different fixes.
`emergencyNonArrivals` surfaces the most serious case: someone sent urgently
with no record they got there.

Producing this at all requires linking a referral issued at one facility to
an arrival at another and an outcome returned to the first. Aggregate
reporting cannot do it; a longitudinal record can. That is why it is the
strongest number in the Ministry pitch.

## Phase 9 — hardening

**Merge is the most dangerous operation in the system.** An incorrect one
attaches a person's history to someone else and can kill them — a
transfusion against the wrong blood group, a prescription against the wrong
allergy. So it requires two *distinct* approvers, keeps a full reversal
snapshot, and **never deletes anything**. Clinical rows keep their original
`person_id`; a pointer resolves reads to the survivor, which is precisely
what makes the whole operation reversible.

Scoring is deliberately conservative. Sex *and* date of birth are
disconfirmers that cap the score below review outright, whatever else
agrees — sharing a name is common in Kenya, and a missed duplicate splits a
history while a false merge shows a clinician someone else's allergies.

**Offline sync** carries a client-generated idempotency key, so a flaky
connection replaying its queue cannot create duplicate diagnoses.
`occurredAt` records when the clinician actually worked, not when the packet
arrived — otherwise a week offline appears to have happened on Tuesday. The
check-in gate still applies: a late write outside its session is refused,
not accepted because it arrived late.

**Rate limiting** counts from the audit log rather than separate counters,
so the limit and the evidence can never disagree.

**MFA** is required server-side for clinical and Ministry accounts.
`accountsMissingMfa` is the enforcement backlog.

## Related

Seed vocabularies live at `../nhp-seed` — 50 diagnoses, 65 capabilities,
41 triage rules, 64 medicines, 22 allergy classes, 76 symptoms, with
validators and three simulators.

## Known gaps

- Dev passwords are in `docker-compose.yml` and `.env.example`. Fine for
  local work, must come from a secret manager before any deployment.
- `BLIND_INDEX_PEPPER` is a placeholder. In production it belongs in a KMS.
- The PostGIS image has no arm64 build, so it runs under emulation on Apple
  Silicon. Works, but slower than native.
- Prisma's `db push` is used rather than versioned migrations. Switch to
  `migrate dev` once the schema settles — before any real data exists.
