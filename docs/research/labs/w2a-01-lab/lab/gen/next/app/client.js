'use client';
import { useEffect } from 'react';
export default function Client() { useEffect(() => { fetch('/data.json').then((r) => r.json()).then((j) => { window.__data = j; }); }, []); return null; }
