import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('database contract audit is routed to its API handler', async () => {
  const [configText, apiSource] = await Promise.all([
    readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
    readFile(new URL('../api/index.js', import.meta.url), 'utf8')
  ]);
  const config = JSON.parse(configText);
  const databaseRewrite = config.rewrites?.find(
    rewrite => rewrite.source === '/database/(.*)'
  );

  assert.deepEqual(databaseRewrite, {
    source: '/database/(.*)',
    destination: '/api/index.js'
  });
  assert.match(apiSource, /path === ['"]\/database\/contract-audit['"] && method === ['"]GET['"]/);
  assert.match(apiSource, /RESEARCH_OS_TABLE_CONTRACT/);
  assert.match(apiSource, /RESEARCH_OS_CRITICAL_RPC_CONTRACT/);
});
