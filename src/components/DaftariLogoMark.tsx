import type { SVGProps } from 'react';

export default function DaftariLogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#FFF7E6" />
      <path
        d="M17 9h18c12.15 0 22 9.85 22 22v18l-13-5H17a6 6 0 0 1-6-6V15a6 6 0 0 1 6-6Z"
        fill="#0D1B2A"
      />
      <path
        d="M5 17h8m-8 8h8m-8 8h8m-8 8h8"
        stroke="#0D1B2A"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M13 31h8l4-8 4 15 5-22 5 28 5-18 4 9 4-4h6"
        stroke="#FF8A00"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m37 49 7 6 15-17"
        stroke="#FFF7E6"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
