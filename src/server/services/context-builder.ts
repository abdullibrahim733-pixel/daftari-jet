/**
 * Builds a business context for background work.
 *
 * Jobs run without an signed-in user, so the context is system-scoped:
 * the same tenant, currency, timezone and feature flags a signed-in
 * reviewer would see, but attributed to the system actor.
 */

import type { Db } from '@/server/db/client';
import { businessFeatures, findBusinessById } from '@/server/repositories/business.repository';
import type { BusinessContext } from '@/server/business-context/context';
import { permissionsForRole } from '@/server/permissions/policy';
import { DEFAULT_CURRENCY, type Currency } from '@/lib/formatting/money';
import { DEFAULT_LOCALE, isLocale } from '@/lib/localization/locales';
import { assertValidTimeZone } from '@/lib/formatting/datetime';

const SYSTEM_USER_ID = 'system';
const SYSTEM_USER_NAME = 'Daftari automation';

export async function businessContextForJob(db: Db, businessId: string | null): Promise<BusinessContext> {
  if (!businessId) {
    throw new Error('A job with no business id cannot build a tenant context');
  }
  const business = await findBusinessById(db, businessId);
  if (!business) {
    throw new Error(`Business ${businessId} no longer exists`);
  }
  return {
    businessId: business.id,
    businessName: business.name,
    userId: SYSTEM_USER_ID,
    userDisplayName: SYSTEM_USER_NAME,
    role: 'owner',
    permissions: permissionsForRole('owner'),
    locale: isLocale(business.locale) ? business.locale : DEFAULT_LOCALE,
    timezone: assertValidTimeZone(business.timezone),
    currency: (business.currency === 'TZS' ? 'TZS' : DEFAULT_CURRENCY) as Currency,
    features: businessFeatures(business),
    retentionAudioDays: business.retention_audio_days,
    analyticsOptIn: business.analytics_opt_in === 1,
    onboardingStep: business.onboarding_step,
  };
}
