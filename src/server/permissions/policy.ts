/**
 * Central permission policy (architecture.md section 8).
 *
 * Roles map to permissions in this one module. Checks run at the route/service
 * boundary and again inside sensitive domain operations. Deny by default.
 */

import { ROLES, type Role } from '@/server/domain/types';
import { forbidden } from '@/lib/errors';

export const PERMISSIONS = [
  'dashboard.read',
  'proposals.read',
  'proposals.review',
  'records.read',
  'records.capture',
  'records.create_manual',
  'records.correct',
  'deni.read',
  'deni.record_payment',
  'inventory.read',
  'inventory.manage',
  'reports.read',
  'reports.export',
  'team.read',
  'team.manage',
  'integrations.read',
  'integrations.manage',
  'settings.read',
  'settings.manage',
  'privacy.read',
  'privacy.manage',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * Derived from the capability table in PRD section 4: staff are limited by
 * default, manager capabilities are grantable by the owner, and owner-only
 * actions (team, integrations, privacy, ownership) are never granted away.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  manager: [
    'dashboard.read',
    'proposals.read',
    'proposals.review',
    'records.read',
    'records.capture',
    'records.create_manual',
    'records.correct',
    'deni.read',
    'deni.record_payment',
    'inventory.read',
    'reports.read',
    'reports.export',
    'team.read',
    'integrations.read',
    'settings.read',
    'privacy.read',
  ],
  staff: [
    'dashboard.read',
    'proposals.read',
    'records.read',
    'records.capture',
    'deni.read',
    'reports.read',
    'team.read',
  ],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw forbidden('Your role does not allow this action', { permission });
  }
}

/** Permissions a manager may be granted by the owner (PRD section 4). */
export const GRANTABLE_MANAGER_PERMISSIONS: readonly Permission[] = [
  'records.create_manual',
  'records.correct',
  'deni.record_payment',
  'reports.export',
  'integrations.manage',
  'settings.manage',
  'privacy.manage',
  'audit.read',
];