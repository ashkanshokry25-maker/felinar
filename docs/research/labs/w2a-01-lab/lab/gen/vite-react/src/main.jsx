import React, { lazy, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router';
import './style.css';
const About = lazy(() => import('./About.jsx'));
const worker = new Worker(new URL('./w.js', import.meta.url), { type: 'module' });
function Home() { useEffect(() => { fetch('/data.json').then((r) => r.json()).then((j) => { window.__data = j; }); worker.postMessage('hi'); }, []); return <h1 id="marker">HELLO-HOME-vite-react</h1>; }
function App() {
  return (<BrowserRouter basename={import.meta.env.BASE_URL.startsWith('.') ? '/' : import.meta.env.BASE_URL}><nav><Link to="/">home</Link> <Link to="/about" id="to-about">about</Link></nav>
    <Suspense fallback="loading"><Routes><Route path="/" element={<Home />} /><Route path="/about" element={<About />} /><Route path="*" element={<h1 id="marker">NOTFOUND-vite-react</h1>} /></Routes></Suspense></BrowserRouter>);
}
createRoot(document.getElementById('root')).render(<App />);
