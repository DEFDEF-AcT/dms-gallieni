import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/dms-gallieni/',   // ← nom exact du dépôt GitHub
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',      // met à jour le service worker tout seul
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'DMS – Atelier BTS MV · Lycée Gallieni',
        short_name: 'DMS Gallieni',
        description: "Gestion d'atelier – ordres de réparation BTS Maintenance des Véhicules",
        lang: 'fr',
        theme_color: '#1d4ed8',
        background_color: '#eff6ff',
        display: 'standalone',
        orientation: 'portrait',
        // base path GitHub Pages
        scope: '/dms-gallieni/',
        start_url: '/dms-gallieni/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // précache de la coque de l'app (les appels Supabase restent en réseau → données fraîches)
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/dms-gallieni/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
})
