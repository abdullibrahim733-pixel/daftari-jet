/**
 * Business (tenant) context.
 *
 * The business is the tenant boundary. A context is only ever produced by
 * verified server middleware, and every repository method requires the tenant
 * scope explicitly so a missing tenant filter is a type error rather than a
 * silent data leak (architecture.md section 8).
 */

import type { Currency } from '@/lib/formatting/money';
import { forbidden } from '@/lib/errors';
import { DEFAULT_CURRENCY } from '@/lib/formatting/money';
import type { Locale } from '@/lib/localization/locales';
import { DEFAULT_LOCALE, isLocale } from '@/lib/localization/locales';
import { assertValidTimeZone } from '@/lib/formatting/datetime';
import { permissionsForRole, type Permission } from '@/server/permissions/policy';
import type { Role } from '@/server/domain/types';
import type { BusinessRow } from '@/server/repositories/business.repository';

export type BusinessFeatures = {
  inventory: boolean;
  manualEntries: boolean;
  deni: boolean;
  exports: boolean;
};

export type BusinessContext = {
  businessId: string;
  businessName: string;
  userId: string;
  userDisplayName: string;
  role: Role;
  permissions: readonly Permission[];
  locale: Locale;
  timezone: string;
  currency: Currency;
  features: BusinessFeatures;
  retentionAudioDays: number;
  analyticsOptIn: boolean;
  onboardingStep: string | null;
};

/** The minimum a repository needs: an already-verified tenant identifier. */
export type TenantScope = {
  businessId: string;
};

export function tenantScope(context: BusinessContext): TenantScope {
  return { businessId: context.businessId };
}

export function hasPermission(context: BusinessContext, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

export function assertPermission(context: BusinessContext, permission: Permission): void {
  if (!hasPermission(context, permission)) {
    throw forbidden('Your role does not allow this action', { permission });
  }
}

/**
 * Builds a context from an already-authorized user and membership role. Callers
 * must have verified the membership first; this function only maps rows.
 */
export function toBusinessContext(
  user: { id: string; display_name: string },
  business: BusinessRow,
  role: Role,
): BusinessContext {
  return {
    businessId: business.id,
    businessName: business.name,
    userId: user.id,
    userDisplayName: user.display_name,
    role,
    permissions: permissionsForRole(role),
    locale: isLocale(business.locale) ? business.locale : DEFAULT_LOCALE,
    timezone: assertValidTimeZone(business.timezone),
    currency: (business.currency === 'TZS' ? 'TZS' : DEFAULT_CURRENCY) as Currency,
    features: businessFeatureFlags(business),
    retentionAudioDays: business.retention_audio_days,
    analyticsOptIn: business.analytics_opt_in === 1,
    onboardingStep: business.onboarding_step,
  };
}

/** Builds a context directly, for jobs and tests that already verified the tenant. */
export function contextForTesting(input: {
  businessId: string;
  businessName?: string;
  userId: string;
  role: Role;
  permissions?: readonly Permission[];
  timezone?: string;
  currency?: Currency;
  locale?: Locale;
  features?: Partial<BusinessFeatures>;
}): BusinessContext {
  return {
    businessId: input.businessId,
    businessName: input.businessName ?? 'Test business',
    userId: input.userId,
    userDisplayName: 'Test user',
    role: input.role,
    permissions: input.permissions ?? permissionsForRole(input.role),
    locale: input.locale ?? DEFAULT_LOCALE,
    timezone: input.timezone ?? 'Africa/Dar_es_Salaam',
    currency: input.currency ?? DEFAULT_CURRENCY,
    features: {
      inventory: false,
      manualEntries: true,
      deni: true,
      exports: true,
      ...input.features,
    },
    retentionAudioDays: 30,
    analyticsOptIn: false,
    onboardingStep: null,
  };
}

function businessFeatureFlags(row: BusinessRow): BusinessFeatures {
  const raw = typeof row.features_json === 'string' ? (JSON.parse(row.features_json) as Record<string, unknown>) : {};
  return {
    inventory: raw.inventory === true,
    manualEntries: raw.manualEntries !== false,
    deni: raw.deni !== false,
    exports: raw.exports !== false,
  };
}