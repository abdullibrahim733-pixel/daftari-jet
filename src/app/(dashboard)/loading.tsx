import BootScreen from '@/components/BootScreen';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

/**
 * Dashboard fallback. Sits inside the route group so the shell chrome is not
 * torn down and rebuilt on a slow navigation.
 */
export default function DashboardLoading() {
  return <BootScreen status={t('app.loadingDashboard')} />;
}