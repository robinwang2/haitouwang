import type { ReactNode } from 'react';

export const metadata = {
  description: 'HaiTouWang web application mount point',
  title: 'HaiTouWang',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
