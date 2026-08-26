/**
 * Regulator verification — the pluggable adapter from the blueprint.
 *
 * Kenya has six clinical regulators, each with its own register. None of
 * them offers a public API today, so the design decision was: build the
 * interface now, mock it, and swap real adapters in later without touching
 * business logic.
 *
 * The mock is deliberately NOT a rubber stamp. It models the failure modes
 * a real register produces — not found, expired, suspended — because code
 * that has only ever seen success handles none of them.
 */

export type Regulator = 'KMPDC' | 'NCK' | 'COC' | 'PPB' | 'KMLTTB' | 'KNDI';

export type Cadre =
  /**
   * Reception. Holds no licence and has no statutory register, so
   * REGULATOR_FOR_CADRE maps them to null and the licence requirement in
   * registerPractitioner does not apply. They can never write clinical
   * data — every clinical write requires a valid licence — which is what
   * makes it safe to employ them through the same practitioner record.
   */
  | 'RECEPTION'
  | 'DOCTOR'
  | 'DENTIST'
  | 'CLINICAL_OFFICER'
  | 'NURSE'
  | 'MIDWIFE'
  | 'PHARMACIST'
  | 'LAB_TECH'
  | 'RADIOGRAPHER'
  | 'NUTRITIONIST'
  | 'PSYCHOLOGIST'
  | 'CHW';

/**
 * Which body registers which cadre. Getting this wrong means a nurse is
 * checked against the doctors' register and always fails.
 *
 * CHW (community health worker) has no statutory register — they are
 * recognised at county level, which the system must accommodate rather
 * than pretend otherwise.
 */
export const REGULATOR_FOR_CADRE: Record<Cadre, Regulator | null> = {
  RECEPTION: null,
  DOCTOR: 'KMPDC',
  DENTIST: 'KMPDC',
  CLINICAL_OFFICER: 'COC',
  NURSE: 'NCK',
  MIDWIFE: 'NCK',
  PHARMACIST: 'PPB',
  LAB_TECH: 'KMLTTB',
  RADIOGRAPHER: 'KMLTTB',
  NUTRITIONIST: 'KNDI',
  PSYCHOLOGIST: null,
  CHW: null,
};

export const REGULATOR_NAMES: Record<Regulator, string> = {
  KMPDC: 'Kenya Medical Practitioners and Dentists Council',
  NCK: 'Nursing Council of Kenya',
  COC: 'Clinical Officers Council',
  PPB: 'Pharmacy and Poisons Board',
  KMLTTB: 'Kenya Medical Laboratory Technicians and Technologists Board',
  KNDI: 'Kenya Nutritionists and Dieticians Institute',
};

export interface VerificationQuery {
  regulator: Regulator;
  licenceNumber: string;
  /** Cross-check the name on the register against what was self-declared. */
  familyName?: string;
}

export type VerificationOutcome =
  | 'VERIFIED'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'SUSPENDED'
  | 'STRUCK_OFF'
  | 'NAME_MISMATCH'
  | 'UNAVAILABLE';

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** Which adapter answered — recorded on the licence for audit. */
  source: string;
  expiresOn?: Date;
  registeredName?: string;
  scope?: string;
  message?: string;
}

export interface VerificationProvider {
  readonly name: string;
  supports(regulator: Regulator): boolean;
  verify(query: VerificationQuery): Promise<VerificationResult>;
}

/**
 * Development adapter.
 *
 * Encodes outcomes in the licence number so tests and demos can exercise
 * every branch deterministically:
 *
 *   *\/EXPIRED\/*    -> EXPIRED
 *   *\/SUSPENDED\/*  -> SUSPENDED
 *   *\/STRUCK\/*     -> STRUCK_OFF
 *   *\/UNKNOWN\/*    -> NOT_FOUND
 *   *\/DOWN\/*       -> UNAVAILABLE
 *   anything else  -> VERIFIED
 */
export class MockVerificationProvider implements VerificationProvider {
  readonly name = 'MOCK';

  supports(): boolean {
    return true;
  }

  async verify(query: VerificationQuery): Promise<VerificationResult> {
    const ref = query.licenceNumber.toUpperCase();

    if (ref.includes('/UNKNOWN/')) {
      return {
        outcome: 'NOT_FOUND',
        source: this.name,
        message: `No entry for ${query.licenceNumber} in the ${query.regulator} register`,
      };
    }
    if (ref.includes('/DOWN/')) {
      return {
        outcome: 'UNAVAILABLE',
        source: this.name,
        message: `${REGULATOR_NAMES[query.regulator]} register did not respond`,
      };
    }
    if (ref.includes('/EXPIRED/')) {
      return {
        outcome: 'EXPIRED',
        source: this.name,
        expiresOn: new Date(Date.UTC(2020, 0, 1)),
        message: 'Retention licence lapsed',
      };
    }
    if (ref.includes('/SUSPENDED/')) {
      return { outcome: 'SUSPENDED', source: this.name, message: 'Practice suspended' };
    }
    if (ref.includes('/STRUCK/')) {
      return { outcome: 'STRUCK_OFF', source: this.name, message: 'Removed from the register' };
    }
    if (query.familyName && ref.includes('/MISMATCH/')) {
      return {
        outcome: 'NAME_MISMATCH',
        source: this.name,
        registeredName: 'Someone Else',
        message: 'Name on the register does not match the application',
      };
    }

    return {
      outcome: 'VERIFIED',
      source: this.name,
      expiresOn: new Date(Date.UTC(new Date().getUTCFullYear() + 2, 11, 31)),
      registeredName: query.familyName,
    };
  }
}

/**
 * Queues everything for a human. The honest default where no API exists —
 * a Ministry officer checks the paper register and records the outcome.
 */
export class ManualReviewProvider implements VerificationProvider {
  readonly name = 'MANUAL_REVIEW';

  supports(): boolean {
    return true;
  }

  async verify(query: VerificationQuery): Promise<VerificationResult> {
    return {
      outcome: 'UNAVAILABLE',
      source: this.name,
      message:
        `Queued for manual verification against the ` +
        `${REGULATOR_NAMES[query.regulator]} register`,
    };
  }
}

/** Routes to whichever adapter handles a regulator; falls back to manual. */
export class VerificationRegistry {
  private readonly providers: VerificationProvider[] = [];
  private readonly fallback = new ManualReviewProvider();

  register(provider: VerificationProvider): this {
    this.providers.push(provider);
    return this;
  }

  async verify(query: VerificationQuery): Promise<VerificationResult> {
    const provider = this.providers.find((p) => p.supports(query.regulator));
    if (!provider) return this.fallback.verify(query);

    try {
      return await provider.verify(query);
    } catch (err) {
      // A regulator being down must never block registration outright —
      // it queues for review instead.
      return {
        outcome: 'UNAVAILABLE',
        source: provider.name,
        message: err instanceof Error ? err.message : 'Verification failed',
      };
    }
  }
}

export function defaultRegistry(): VerificationRegistry {
  return new VerificationRegistry().register(new MockVerificationProvider());
}
