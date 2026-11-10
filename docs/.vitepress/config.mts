import { defineConfig } from 'vitepress';
export default defineConfig({
  title: 'Multi Agent SDK',
  description: 'Build apps on Codex, Claude, Cursor, and Antigravity with TypeScript.',
  base: '/multi-agent-sdk/',
  lang: 'en-US',
  themeConfig: {
    nav: [{ text: 'Guide', link: '/guide/installation' }, { text: 'API', link: '/api/' }],
    sidebar: [
      { text: 'Guide', items: [
        { text: 'Setup', link: '/guide/installation' },
        { text: 'First conversation', link: '/guide/quick-start' },
        { text: 'Sessions and history', link: '/guide/sessions' },
        { text: 'State and events', link: '/guide/events' },
        { text: 'Tools and permissions', link: '/guide/tools' },
        { text: 'Host security', link: '/guide/security' },
        { text: 'Troubleshooting', link: '/guide/troubleshooting' },
      ] },
      { text: 'Reference', items: [
        { text: 'Exports and operations', link: '/api/' },
        { text: 'Native Codex surface', link: '/api/codex' },
        { text: 'Consumer contract', link: '/consumer-contract' },
      ] },
      { text: 'Contribute', items: [
        { text: 'Development', link: '/guide/development' },
        { text: 'Testing', link: '/guide/testing' },
        { text: 'Releases', link: '/guide/releases' },
      ] },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Korus-Dev/multi-agent-sdk' }],
    footer: { message: 'Released under the Apache License 2.0.' },
  },
});
