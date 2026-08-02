import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const [
  translator,
  importerSource,
  aiRouter,
  settings,
  apiSource,
  analyzer,
  validator,
  dataAnalysis,
  questionConstructor
] = await Promise.all([
  fs.readFile(new URL('../translator.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../question-bank-import.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../ai-router.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../settings.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../analyzer.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../validator.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../data-analysis.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8')
]);

test('uploaded questionnaire source is parsed as data and cannot execute code', () => {
  assert.match(translator, /<script src="question-bank-import\.js"><\/script>/);
  assert.doesNotMatch(translator, /\bnew Function\b|\beval\s*\(/);

  const context = {
    crypto: webcrypto,
    Uint8Array,
    TextDecoder,
    console,
    executed: false
  };
  context.globalThis = context;
  vm.runInNewContext(importerSource, context);

  assert.throws(
    () => context.QuestionBankImport.parseStructuredText(
      'QUESTION_BANK = {"Q": (globalThis.executed = True)}'
    ),
    /Executable or unsupported token|Unexpected token|Expected/
  );
  assert.equal(context.executed, false);
});

test('browser code neither stores provider secrets nor contacts providers directly', () => {
  assert.doesNotMatch(aiRouter, /api\.groq\.com|generativelanguage\.googleapis\.com|getApiKey/);
  assert.doesNotMatch(aiRouter, /localStorage\.(?:getItem|setItem)\(['"]ai_api_keys/);
  assert.match(aiRouter, /localStorage\.removeItem\(['"]ai_api_keys/);
  assert.match(aiRouter, /fetch\(['"]\/api\/ai\/request['"]/);

  assert.doesNotMatch(settings, /id=["']key_(?:groq|gemini)["']/);
  assert.doesNotMatch(settings, /localStorage\.(?:getItem|setItem)\(['"]ai_api_keys/);
  assert.match(settings, /localStorage\.removeItem\(['"]ai_api_keys/);
  assert.doesNotMatch(apiSource, /gemini-1\.5-flash/);
  assert.match(apiSource, /gemini-3\.6-flash/);
  assert.match(apiSource, /gemini-3\.5-flash-lite/);
});

test('uploaded, AI-generated, and dataset labels are escaped before HTML rendering', () => {
  assert.match(analyzer, /const esc=value=>String/);
  assert.match(analyzer, /candidate\.limitations\.map\(esc\)/);
  assert.match(analyzer, /safeHttpUrl\(metadata\.url\|\|candidate\.primary_source\.claimed_url\)/);
  assert.match(validator, /escapeHtml\(err\.message\)/);
  assert.match(validator, /escapeHtml\(err\)/);
  assert.match(validator, /escapeHtml\(warn\)/);
  assert.match(dataAnalysis, /function esc\(value\)/);
  assert.match(dataAnalysis, /select\.add\(new Option\(label\(item\),value\(item\)\)\)/);
  assert.match(dataAnalysis, /new Option\(`\$\{localizedText\(study\.title\)\}/);
  assert.match(dataAnalysis, /\(result\.assumptions\|\|\[\]\)\.map\(item=>`<li>\$\{esc\(item\)\}<\/li>`\)/);
  assert.match(dataAnalysis, /esc\(JSON\.stringify\(snapshot,null,2\)\)/);
  assert.match(questionConstructor, /\$\{escapeHtml\(opt\.l\)\}/);
  assert.doesNotMatch(questionConstructor, /\$\{opt\.l\}/);
});

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

function jsonFetch(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

test('AI gateway requires a researcher and keeps the provider key server-side', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.GROQ_API_KEY = 'server-only-groq-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#security`
  )).default;

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return jsonFetch([{
        session_id: 'e3ce976f-acde-47a7-8247-ef92986ca3da',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z',
        revoked_at: null
      }]);
    }
    if (calls.length === 2) {
      return jsonFetch([{
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        username: 'researcher',
        user_identifier: 'RESEARCHER-001',
        role: 'researcher',
        status: 'active',
        created_by_account_id: null
      }]);
    }
    return jsonFetch({
      choices: [{ message: { content: '{"items":[{"code":"Q1"}]}' } }]
    });
  };

  try {
    const unauthenticated = response();
    await handler({
      method: 'POST',
      url: '/api/ai/request',
      headers: { host: 'research-os.test' },
      body: {}
    }, unauthenticated);
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(calls.length, 0);

    const res = response();
    await handler({
      method: 'POST',
      url: '/api/ai/request',
      headers: {
        host: 'research-os.test',
        authorization: 'Bearer researcher-browser-session'
      },
      body: {
        task: 'translator',
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        system_prompt: 'Return JSON.',
        payload: [{ code: 'Q1', prompt: 'Question?' }]
      }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.result, { items: [{ code: 'Q1' }] });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[2].options.headers.Authorization, 'Bearer server-only-groq-key');
    assert.doesNotMatch(calls[2].options.body, /server-only-groq-key|researcher-browser-session/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
