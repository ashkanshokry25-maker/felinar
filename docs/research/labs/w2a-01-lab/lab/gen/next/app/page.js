import Link from 'next/link';
import Client from './client';
export default function Page() {
  return (<><nav><Link href="/">home</Link> <Link id="to-about" href="/about">about</Link></nav><h1 id="marker">HELLO-HOME-next</h1><Client /></>);
}
