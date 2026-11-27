import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { PAGES, REPO } from './src/order.mjs';

const groups = [...new Set(PAGES.map((p) => p.group))].map((label) => ({
  label,
  items: PAGES.filter((p) => p.group === label).map((p) => `docs/${p.slug}`),
}));

export default defineConfig({
  // The public address of the site, for the sitemap and canonical links; set DOCS_SITE when deploying.
  site: process.env.DOCS_SITE || 'https://hos-docs.example.com',
  // build:check sets these so the built pages open from file:// for the headless render.
  base: process.env.DOCS_BASE ?? '/',
  outDir: process.env.DOCS_OUT ?? './dist',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'hos docs',
      description: 'Run your agents like a team that remembers.',
      logo: { src: './src/assets/mark.svg', alt: 'hos' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/site/` },
      customCss: [
        '@fontsource-variable/overpass',
        '@fontsource-variable/overpass-mono',
        './src/styles/hos.css',
      ],
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/Empty.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      sidebar: groups,
      pagination: true,
    }),
  ],
});
