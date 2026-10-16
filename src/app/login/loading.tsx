import BootScreen from '@/components/BootScreen';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

/** Sign-in fallback. */
export default function LoginLoading() {
  return <BootScreen title={t('app.bootTitle')} status={t('app.loadingDashboard')} />;
}