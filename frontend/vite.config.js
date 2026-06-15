import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

// Copy Syncfusion pdfium WASM + JS to public so the client-side renderer can load them
function copySyncfusionPdfium() {
  return {
    name: 'copy-syncfusion-pdfium',
    buildStart() {
      try {
        const destDir = resolve('./public/ej2-pdfviewer-lib')
        mkdirSync(destDir, { recursive: true })
        const srcDir = resolve('./node_modules/@syncfusion/ej2-pdfviewer/dist/ej2-pdfviewer-lib')
        for (const file of ['pdfium.js', 'pdfium.wasm']) {
          const src = `${srcDir}/${file}`
          if (existsSync(src)) copyFileSync(src, `${destDir}/${file}`)
        }
      } catch (e) {
        console.warn('Could not copy Syncfusion pdfium assets:', e.message)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    copySyncfusionPdfium(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    dedupe: ['@syncfusion/ej2-base'],
  },
  optimizeDeps: {
    include: [
      '@syncfusion/ej2-base',
      '@syncfusion/ej2-react-pdfviewer',
      '@syncfusion/ej2-pdfviewer',
    ],
    exclude: ['pdfjs-dist'],
  },
})
