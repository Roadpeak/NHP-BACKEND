/**
 * Duplicate detection and merge — Phase 9.
 *
 * The most dangerous operation in NHP. An incorrect merge attaches one
 * person's medical history to another and can directly cause harm — a
 * transfusion against the wrong blood group, a prescription against the
 * wrong allergy.
 *
 * So: two distinct approvers, a full reversal snapshot kept indefinitely,
 * and the losing person row is NEVER deleted. Clinical rows keep pointing
 * at their original person_id; resolution happens at read time by following
 * `mergedIntoId`, which is what makes the whole thing reversible.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { decryptField } from './crypto.js';

export type Db = PrismaClient | Prisma.TransactionClient;

export class MergeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

/** Below this, a candidate pair is not worth a human's attention. */
export const REVIEW_THRESHOLD = 0.6;
/** At or above this, the match is strong enough to queue automatically. */
export const AUTO_QUEUE_THRESHOLD = 0.85;

export interface MatchEvidence {
  field: string;
  weight: number;
  matched: boolean;
  note?: string;
}

/**
 * Scores how likely two records are the same person.
 *
 * Deliberately conservative. A false merge is far worse than a missed one:
 * a split history means a clinician sees less than they should, while a
 * wrong merge means they see someone else's allergies as this patient's.
 */
export function scoreMatch(
  a: {
    givenName: string;
    familyName: string;
    dateOfBirth: Date;
    sexAtBirth: string;
    countyId: string;
  },
  b: typeof a,
): { score: number; evidence: MatchEvidence[] } {
  const evidence: MatchEvidence[] = [];

  const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, '');

  const familyMatch = norm(a.familyName) === norm(b.familyName);
  evidence.push({ field: 'familyName', weight: 0.3, matched: familyMatch });

  const givenMatch = norm(a.givenName) === norm(b.givenName);
  evidence.push({ field: 'givenName', weight: 0.25, matched: givenMatch });

  const dobMatch = a.dateOfBirth.toISOString().slice(0, 10) ===
    b.dateOfBirth.toISOString().slice(0, 10);
  evidence.push({ field: 'dateOfBirth', weight: 0.3, matched: dobMatch });

  // Sex is a strong DISCONFIRMER: two records differing here are almost
  // certainly different people, whatever else agrees.
  const sexMatch = a.sexAtBirth === b.sexAtBirth;
  evidence.push({
    field: 'sexAtBirth',
    weight: 0.1,
    matched: sexMatch,
    note: sexMatch ? undefined : 'Mismatch — likely different people',
  });

  const countyMatch = a.countyId === b.countyId;
  evidence.push({ field: 'county', weight: 0.05, matched: countyMatch });

  let score = evidence.reduce((s, e) => s + (e.matched ? e.weight : 0), 0);

  // Two DISCONFIRMERS cap the score below review outright, whatever else
  // agrees. Both are far more informative than the fields that match:
  //
  //   sex        — two records differing here are almost certainly
  //                different people.
  //   birth date — sharing a name is common in Kenya; sharing a name AND a
  //                birth date is what makes a duplicate likely. Without
  //                this cap, two unrelated people called Achieng Otieno
  //                score 0.70 and reach a reviewer as a probable match.
  //
  // A missed duplicate splits a history, which is bad. A false merge shows
  // a clinician someone else's allergies, which can kill. The asymmetry
  // justifies being this conservative.
  if (!sexMatch || !dobMatch) score = Math.min(score, REVIEW_THRESHOLD - 0.01);

  return { score: Math.round(score * 100) / 100, evidence };
}

/**
 * Finds likely duplicates.
 *
 * Blocks on date of birth to keep this tractable — comparing every person
 * to every other is O(n²) and unrunnable at national scale. Two records for
 * the same person almost always agree on date of birth, and where they do
 * not, a human report is the realistic detection path.
 */
export async function findDuplicateCandidates(
  db: Db,
  opts: { limit?: number; countyId?: string } = {},
) {
  const people = await db.person.findMany({
    where: {
      mergedIntoId: null,
      lifeStatus: { not: 'INACTIVE' },
      ...(opts.countyId ? { countyId: opts.countyId } : {}),
    },
    select: {
      id: true,
      displayNumber: true,
      givenName: true,
      familyName: true,
      dateOfBirth: true,
      sexAtBirth: true,
      countyId: true,
      createdAt: true,
    },
  });

  const blocks = new Map<string, typeof people>();
  for (const p of people) {
    const key = p.dateOfBirth.toISOString().slice(0, 10);
    const block = blocks.get(key) ?? [];
    block.push(p);
    blocks.set(key, block);
  }

  const candidates: Array<{
    survivingId: string;
    mergedId: string;
    score: number;
    evidence: MatchEvidence[];
  }> = [];

  for (const block of blocks.values()) {
    if (block.length < 2) continue;

    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        const a = { ...block[i], givenName: decryptField(block[i].givenName), familyName: decryptField(block[i].familyName) };
        const b = { ...block[j], givenName: decryptField(block[j].givenName), familyName: decryptField(block[j].familyName) };

        const { score, evidence } = scoreMatch(a, b);
        if (score < REVIEW_THRESHOLD) continue;

        // The OLDER record survives by default — it has more history
        // attached and more identifiers pointing at it.
        const [surviving, merged] =
          block[i].createdAt <= block[j].createdAt
            ? [block[i], block[j]]
            : [block[j], block[i]];

        candidates.push({
          survivingId: surviving.id,
          mergedId: merged.id,
          score,
          evidence,
        });
      }
    }
  }

  return candidates
    .sort((x, y) => y.score - x.score)
    .slice(0, opts.limit ?? 50);
}

export async function proposeMerge(
  db: Db,
  input: {
    survivingPersonId: string;
    mergedPersonId: string;
    detectedBy: 'AUTOMATIC' | 'FACILITY_REPORT' | 'CITIZEN_REPORT';
    score?: number;
    evidence?: MatchEvidence[];
  },
) {
  if (input.survivingPersonId === input.mergedPersonId) {
    throw new MergeError('Cannot merge a record into itself', 'SELF_MERGE');
  }

  const [surviving, merged] = await Promise.all([
    db.person.findUnique({
      where: { id: input.survivingPersonId },
      select: { id: true, mergedIntoId: true },
    }),
    db.person.findUnique({
      where: { id: input.mergedPersonId },
      select: { id: true, mergedIntoId: true },
    }),
  ]);

  if (!surviving || !merged) {
    throw new MergeError('One or both records not found', 'PERSON_NOT_FOUND');
  }
  if (merged.mergedIntoId) {
    throw new MergeError('That record has already been merged', 'ALREADY_MERGED');
  }
  if (surviving.mergedIntoId) {
    throw new MergeError(
      'The surviving record is itself merged into another — merge into the ' +
        'final survivor instead',
      'SURVIVOR_IS_MERGED',
    );
  }

  const existing = await db.mergeRequest.findFirst({
    where: {
      survivingPersonId: input.survivingPersonId,
      mergedPersonId: input.mergedPersonId,
      status: 'PENDING',
    },
    select: { id: true },
  });
  if (existing) {
    throw new MergeError('A merge is already pending for this pair', 'ALREADY_PROPOSED');
  }

  return db.mergeRequest.create({
    data: {
      survivingPersonId: input.survivingPersonId,
      mergedPersonId: input.mergedPersonId,
      detectedBy: input.detectedBy,
      matchScore: input.score ?? null,
      matchEvidence: (input.evidence ?? []) as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
    },
  });
}

/**
 * Executes a merge, once two distinct people have approved it.
 *
 * Never deletes. The losing person keeps every clinical row it had; a
 * pointer is set so reads resolve to the survivor. That is what makes the
 * operation reversible, and reversibility is the only reason it is safe
 * enough to permit at all.
 */
export async function executeMerge(
  db: PrismaClient,
  input: { mergeRequestId: string; approvedBy: string; secondApprover: string },
) {
  if (input.approvedBy === input.secondApprover) {
    throw new MergeError(
      'A merge needs two DISTINCT approvers. An incorrect merge can kill ' +
        'someone — one person must not be able to authorise it alone.',
      'SAME_APPROVER',
    );
  }

  const request = await db.mergeRequest.findUnique({
    where: { id: input.mergeRequestId },
  });
  if (!request) throw new MergeError('Merge request not found', 'REQUEST_NOT_FOUND');
  if (request.status !== 'PENDING') {
    throw new MergeError(`This merge is already ${request.status}`, 'NOT_PENDING');
  }

  // Everything needed to undo, captured BEFORE anything changes.
  const [identifiers, guardianships, account] = await Promise.all([
    db.identifier.findMany({ where: { personId: request.mergedPersonId } }),
    db.guardianship.findMany({
      where: {
        OR: [
          { dependantId: request.mergedPersonId },
          { guardianId: request.mergedPersonId },
        ],
      },
    }),
    db.account.findUnique({ where: { personId: request.mergedPersonId } }),
  ]);

  const snapshot = {
    capturedAt: new Date().toISOString(),
    mergedPersonId: request.mergedPersonId,
    survivingPersonId: request.survivingPersonId,
    identifiers: identifiers.map((i) => ({ id: i.id, type: i.type, status: i.status })),
    guardianships: guardianships.map((g) => ({ id: g.id, status: g.status })),
    accountId: account?.id ?? null,
  };

  return db.$transaction(async (tx) => {
    // Identifiers move to the survivor so a search on either ID finds the
    // right record. Any that would clash are superseded, not dropped.
    for (const identifier of identifiers) {
      const clash = await tx.identifier.findFirst({
        where: {
          personId: request.survivingPersonId,
          type: identifier.type,
          valueIndex: identifier.valueIndex,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.identifier.update({
        where: { id: identifier.id },
        data: clash
          ? { status: 'SUPERSEDED' }
          : { personId: request.survivingPersonId },
      });
    }

    // Guardianship links follow the person.
    await tx.guardianship.updateMany({
      where: { dependantId: request.mergedPersonId },
      data: { dependantId: request.survivingPersonId },
    });
    await tx.guardianship.updateMany({
      where: { guardianId: request.mergedPersonId },
      data: { guardianId: request.survivingPersonId },
    });

    // The duplicate's credentials are closed — one person, one login.
    //
    // The account stays ATTACHED to the person it belonged to. Detaching it
    // would leave an account owned by nobody, which `account_one_owner_ck`
    // correctly refuses — and would also make the merge unreversible, since
    // there would be nothing to restore it to.
    if (account) {
      await tx.account.update({
        where: { id: account.id },
        data: { status: 'CLOSED' },
      });
    }

    // The pointer. Clinical rows are untouched and still reference the
    // merged id; reads follow this to the survivor.
    await tx.person.update({
      where: { id: request.mergedPersonId },
      data: { mergedIntoId: request.survivingPersonId, lifeStatus: 'INACTIVE' },
    });

    return tx.mergeRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        approvedBy: input.approvedBy,
        secondApprover: input.secondApprover,
        executedAt: new Date(),
        reversalSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
  });
}

/**
 * Undoes a merge.
 *
 * Possible precisely because nothing was deleted. Restores the pointer,
 * the identifiers and the guardianships from the snapshot.
 */
export async function reverseMerge(
  db: PrismaClient,
  input: { mergeRequestId: string; reversedBy: string; reason: string },
) {
  const request = await db.mergeRequest.findUnique({
    where: { id: input.mergeRequestId },
  });
  if (!request) throw new MergeError('Merge request not found', 'REQUEST_NOT_FOUND');
  if (request.status !== 'APPROVED') {
    throw new MergeError('Only an executed merge can be reversed', 'NOT_EXECUTED');
  }
  if (!request.reversalSnapshot) {
    throw new MergeError(
      'No reversal snapshot — this merge cannot be safely undone',
      'NO_SNAPSHOT',
    );
  }
  if (!input.reason?.trim()) {
    throw new MergeError('A reversal requires a reason', 'REASON_REQUIRED');
  }

  const snapshot = request.reversalSnapshot as unknown as {
    identifiers: Array<{ id: string; status: string }>;
    guardianships: Array<{ id: string; status: string }>;
    accountId: string | null;
  };

  return db.$transaction(async (tx) => {
    for (const i of snapshot.identifiers) {
      await tx.identifier.update({
        where: { id: i.id },
        data: {
          personId: request.mergedPersonId,
          status: i.status as 'ACTIVE' | 'SUPERSEDED' | 'DISPUTED' | 'REVOKED',
        },
      });
    }

    for (const g of snapshot.guardianships) {
      const link = await tx.guardianship.findUnique({ where: { id: g.id } });
      if (!link) continue;
      await tx.guardianship.update({
        where: { id: g.id },
        data:
          link.dependantId === request.survivingPersonId
            ? { dependantId: request.mergedPersonId }
            : { guardianId: request.mergedPersonId },
      });
    }

    if (snapshot.accountId) {
      await tx.account.update({
        where: { id: snapshot.accountId },
        data: { status: 'ACTIVE' },
      });
    }

    await tx.person.update({
      where: { id: request.mergedPersonId },
      data: { mergedIntoId: null, lifeStatus: 'ALIVE' },
    });

    return tx.mergeRequest.update({
      where: { id: request.id },
      data: { status: 'REVERSED' },
    });
  });
}

/** Follows the merge chain to the record that survives. */
export async function resolvePerson(db: Db, personId: string): Promise<string> {
  let current = personId;
  const seen = new Set<string>([current]);

  for (let hops = 0; hops < 10; hops++) {
    const person = await db.person.findUnique({
      where: { id: current },
      select: { mergedIntoId: true },
    });
    if (!person?.mergedIntoId) return current;
    if (seen.has(person.mergedIntoId)) {
      throw new MergeError('Merge pointer cycle detected', 'MERGE_CYCLE');
    }
    seen.add(person.mergedIntoId);
    current = person.mergedIntoId;
  }
  throw new MergeError('Merge chain too long', 'MERGE_CHAIN_TOO_LONG');
}

/**
 * A merged person's complete clinical history.
 *
 * Rows still carry their original person_id, so a naive query on the
 * survivor alone would silently lose the duplicate's history — the exact
 * failure a merge is supposed to fix.
 */
export async function mergedPersonIds(db: Db, survivingId: string): Promise<string[]> {
  const merged = await db.person.findMany({
    where: { mergedIntoId: survivingId },
    select: { id: true },
  });
  return [survivingId, ...merged.map((m) => m.id)];
}
