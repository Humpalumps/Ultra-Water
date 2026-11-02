import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// builds ship the licences of bundled npm packages (licenses.md) and of adapted code (THIRD_PARTY_NOTICES.md)
export default defineConfig({
  build: { license: { fileName: 'licenses.md' } },
  plugins: [{
    name: 'third-party-notices',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync('THIRD_PARTY_NOTICES.md', 'utf8') });
    },
  }],
});
