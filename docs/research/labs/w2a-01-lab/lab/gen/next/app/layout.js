export const metadata = { title: 'next app' };
export default function RootLayout({ children }) {
  return (<html lang="en"><body style={{ background: 'url(/bg.png)' }}>{children}</body></html>);
}
