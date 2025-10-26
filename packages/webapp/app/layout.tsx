import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Venmail Agent Console',
  description: 'Web dashboard supporting the Venmail contact reputation extension'
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
