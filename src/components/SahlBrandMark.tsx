import type { SVGProps } from 'react';

export default function SahlBrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="2" y="2" width="60" height="60" rx="16" fill="var(--color-brand-forest)" />
      <text
        x="32"
        y="45"
        fill="var(--color-brand-gold)"
        direction="rtl"
        unicodeBidi="plaintext"
        textAnchor="middle"
        fontFamily="'Noto Sans Arabic', 'Noto Naskh Arabic', 'Segoe UI', sans-serif"
        fontSize="39"
        fontWeight="700"
      >
        س
      </text>
    </svg>
  );
}
