/**
 * Dashboard route group.
 *
 * This is the authoritative authentication gate. `src/proxy.ts` only checks for
 * the presence of a cookie; the real session resolution — token hashing, user
 * status, expiry and revocation — happens here, on the server, against the
 * database. A caller with no valid session never reaches a dashboard page at
 * all, rather than rendering a shell that fails its own fetches.
 *
 * Pages inside this group stay client components and keep fetching from
 * `/api/v1/*`; nothing about their data contract changes.
 */

import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { optionalSession } from '@/server/auth/session';
import DashboardShell from './components/DashboardShell';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await optionalSession();

  if (!session) {
    // `next` is read by the login screen to return the user to where they were
    // headed. It is validated there against a same-origin path list before use.
    redirect('/login?next=/');
  }

  return <DashboardShell>{children}</DashboardShell>;
}