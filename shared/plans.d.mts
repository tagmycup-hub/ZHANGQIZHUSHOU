export type PlanId = 't1' | 't2';
export type Period = 'month' | 'year';
export type EffectivePlan = 'trial' | 't1' | 't2' | 'owner' | 'expired';
export interface PlanDef { name: string; month: number; year: number; ai: number; push: boolean; export: boolean }
export declare const TRIAL: { days: number; ai: number };
export declare const PLANS: Record<PlanId, PlanDef>;
export declare const PLAN_LABEL: Record<EffectivePlan, string>;
export declare function monthKey(d?: Date): string;
export interface Entitlement {
  plan: EffectivePlan;
  period: Period | null;
  trialUntil: string | null;
  planUntil: string | null;
  features: { edit: boolean; push: boolean; export: boolean };
  ai: { key: string | null; limit: number };
  daysLeft: number | null;
}
export declare function entitlement(profile: { plan?: string | null; period?: string | null; plan_until?: string | null; trial_until?: string | null } | null, opts?: { email?: string; owners?: string[]; now?: Date; plans?: Record<PlanId, PlanDef>; trial?: { days: number; ai: number } }): Entitlement;
export declare function priceOf(plan: string, period: string, plans?: Record<PlanId, PlanDef>): number | null;
