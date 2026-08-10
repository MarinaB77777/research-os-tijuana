import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Vercel routes database endpoints through the API handler', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const databaseRewrite = config.rewrites?.find(
    rewrite => rewrite.source === '/database/(.*)'
  );

  assert.deepEqual(databaseRewrite, {
    source: '/database/(.*)',
    destination: '/api/index.js'
  });
});
