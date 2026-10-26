module.exports = {
  title: 'doc', url: 'https://example.org', baseUrl: process.env.BASE || '/',
  onBrokenLinks: 'warn',
  future: process.env.HASH ? { experimental_router: 'hash' } : {},
  presets: [['classic', { docs: false, blog: false, theme: {} }]],
};
