import { redirect } from 'next/navigation';

/**
 * Root — bounce straight to the portfolio page. Auth middleware handles
 * redirect-to-login for unauthenticated users.
 */
export default function HomePage(): never {
  redirect('/portfolio');
}
