import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: './src/index.ts',
  format: ['commonjs'],
  platform: 'node',
  outDir: './dist',
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  exports: true,
  cjsDefault: true,
});
