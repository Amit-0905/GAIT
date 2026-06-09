import { defineConfig } from 'vite';
import { resolve } from 'path';
export default defineConfig({
  build: {
    lib: { entry: resolve(__dirname, 'src/index.ts'), name: 'Gait', fileName: (format) => `gait-v2.${format}.js`, formats: ['es', 'umd', 'iife'] },
    minify: 'terser', terserOptions: { compress: { drop_console: true, drop_debugger: true }, mangle: { safari10: true } },
    sourcemap: true, outDir: 'dist'
  }
});
