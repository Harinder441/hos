import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, createReadStream, existsSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

const EXCALIDRAW_FONTS = join(process.cwd(), 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');

function excalidrawFonts(): Plugin {
  let outDir = '';
  return {
    name: 'hos-excalidraw-fonts',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        const file = normalize(join(EXCALIDRAW_FONTS, decodeURIComponent((req.url ?? '').split('?')[0]!)));
        if (!file.startsWith(EXCALIDRAW_FONTS + sep) || !existsSync(file)) return next();
        res.setHeader('content-type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(EXCALIDRAW_FONTS, join(outDir, 'excalidraw/fonts'), { recursive: true });
    },
  };
}

const EXCALIDRAW_STROKE_WIDTHS = /thin:\s*1,\s*bold:\s*2,\s*extraBold:\s*4/;

function excalidrawStrokeWidths(): Plugin {
  return {
    name: 'hos-excalidraw-stroke-widths',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist') || !EXCALIDRAW_STROKE_WIDTHS.test(code)) return null;
      return { code: code.replace(EXCALIDRAW_STROKE_WIDTHS, 'thin: 0.2, bold: 0.33, extraBold: 1'), map: null };
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), excalidrawFonts(), excalidrawStrokeWidths()],
  optimizeDeps: { rolldownOptions: { plugins: [excalidrawStrokeWidths()] } },
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4517', ws: true } } },
});
