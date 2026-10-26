import { HtmlBasePlugin } from '@11ty/eleventy';
export default function (eleventyConfig) {
  if (process.env.HTMLBASE) eleventyConfig.addPlugin(HtmlBasePlugin);
  eleventyConfig.addPassthroughCopy({ static: '.' });
  return { dir: { input: 'src', output: process.env.OUT || '_site' }, pathPrefix: process.env.PREFIX || '/' };
}
