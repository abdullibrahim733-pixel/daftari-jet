import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import SahlBrandMark from './SahlBrandMark';

export default function SahlBrandLockup({
  className = '',
  href = '/',
}: {
  className?: string;
  href?: string;
}) {
  return (
    <Link
      className={`brand-lockup ${className}`.trim()}
      href={href}
      aria-label={`${BRAND.name} (${BRAND.arabicName})`}
    >
      <SahlBrandMark className="brand-logo-mark" />
      <span className="brand-lockup-copy">
        <span className="brand-name">{BRAND.name}</span>
        <span className="brand-arabic" lang="ar" dir="rtl">{BRAND.arabicName}</span>
      </span>
    </Link>
  );
}
