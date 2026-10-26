export default {
  output: 'export',
  distDir: process.env.DIST || 'out',
  images: { unoptimized: true },
  basePath: process.env.BASE_PATH || '',
  trailingSlash: process.env.TS === '1',
};
