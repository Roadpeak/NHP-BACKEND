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
- [ ] Phase 1 — identity: registration, guardianship, promotion at 18
- [ ] Phase 2 — facilities: registry, capabilities, KEPH levels
- [ ] Phase 3 — clinicians: licences, affiliation, check-in API
- [ ] Phase 4 — clinical core: encounters, coded diagnoses, prescribing
- [ ] Phases 5–9 — consent, triage, Ministry, referrals, hardening

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
