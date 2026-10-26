export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  telemetry: false,
  devtools: { enabled: false },
  app: { baseURL: process.env.BASE || '/' },
  ssr: process.env.SPA ? false : true,
});
