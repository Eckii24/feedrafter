import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    manifest: { name: 'Feedrafter', short_name: 'Feedrafter', start_url: '/', display: 'standalone', background_color: '#f4f6f3', theme_color: '#153c46', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/events(?:\/|$)/], runtimeCaching: [] },
  })],
  build: { outDir: 'dist/web', emptyOutDir: true },
});
