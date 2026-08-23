# NHP — National Health Portal

A longitudinal health record and care-routing system for Kenya.

**Phase 0 complete.** The database refuses what it must refuse — proven by
23 passing tests, not asserted in a document.

## Quick start

```bash
pnpm install
pnpm db:up          # Postgres 16 + PostGIS on localhost:5434
pnpm migrate        # push the Prisma schema
pnpm harden         # apply the guarantees (roles, triggers, constraints)
pnpm test           # prove the twelve refusals
```

`pnpm setup` runs all of the above in order.

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
- [ ] Phase 4 — clinical core: encounters, coded diagnoses, prescribing
- [ ] Phases 5–9 — consent, triage, Ministry, referrals, hardening

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
