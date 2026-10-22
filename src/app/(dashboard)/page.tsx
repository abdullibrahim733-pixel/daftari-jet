import { redirect } from 'next/navigation';

// SAHL is capture-first: the signed-in landing screen is Record.
export default function HomePage() {
  redirect('/record');
}
