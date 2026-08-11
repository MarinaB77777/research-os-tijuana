import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const [moduleSource, constructor, apiSource, settings] = await Promise.all([
  fs.readFile(new URL('../eligibility-criteria.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../constructor_study.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/index.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../settings.html', import.meta.url), 'utf8')
]);

const context = { crypto: webcrypto, console };
context.globalThis = context;
vm.runInNewContext(moduleSource, context);
const EC = context.EligibilityCriteria;

test('standard criteria are localized protocol templates, not automatic decisions', () => {
  const es = EC.catalog('es');
  const en = EC.catalog('en');
  const ru = EC.catalog('ru');
  assert.ok(es.length >= 10);
  assert.equal(es.length, en.length);
  assert.equal(en.length, ru.length);
  assert.ok(es.some(item => item.type === 'inclusion'));
  assert.ok(es.some(item => item.type === 'exclusion'));
  assert.throws(() => EC.fromTemplate('age_range', '', 'ru'), /value is required/i);
  const criterion = EC.fromTemplate('age_range', '18–65 лет', 'ru');
  assert.equal(criterion.type, 'inclusion');
  assert.match(criterion.criterion_id, /^[0-9a-f-]{36}$/i);
  assert.match(criterion.statement, /18–65 лет/);
  assert.equal(criterion.source, 'standard_template');
  assert.equal(criterion.researcher_disposition, 'accepted');
});

test('old criterion arrays migrate losslessly to the structured protocol', () => {
  const design = EC.normalizeDesign({
    inclusion_criteria: ['Adult participant'],
    exclusion_criteria: ['Duplicate enrollment']
  });
  assert.equal(design.eligibility_criteria.length, 2);
  const originalId = design.eligibility_criteria.find(item => item.type === 'inclusion').criterion_id;
  assert.deepEqual(Array.from(design.inclusion_criteria), ['Adult participant']);
  assert.deepEqual(Array.from(design.exclusion_criteria), ['Duplicate enrollment']);
  EC.replaceFromLines(design, 'inclusion', ['Adult participant', 'Lives in Tijuana']);
  assert.deepEqual(Array.from(design.inclusion_criteria), ['Adult participant', 'Lives in Tijuana']);
  assert.equal(design.eligibility_criteria.filter(item => item.type === 'inclusion').length, 2);
  EC.replaceFromLines(design, 'inclusion', ['Adult participants', 'Lives in Tijuana']);
  assert.equal(design.eligibility_criteria.find(item => item.type === 'inclusion').criterion_id, originalId);
  assert.equal(design.eligibility_criteria.find(item => item.type === 'inclusion').researcher_modified, true);
});

test('AI receives only an explicit study-level context and returns pending proposals', () => {
  const scoped = EC.scopedContext({
    title: 'Social support', description: 'Cross-sectional study', primary_language: 'es-MX',
    respondent_identifier: 'MUST-NOT-LEAK', password: 'MUST-NOT-LEAK',
    study_design: {
      design_type: 'cross_sectional', objective: 'Describe social support',
      research_questions: ['What is the level?'], hypotheses: [], target_sample_size: 100,
      eligibility_criteria: []
    },
    timepoints: [{}], groups: [{ title: 'Community adults', description: 'Target group' }]
  });
  assert.doesNotMatch(JSON.stringify(scoped), /MUST-NOT-LEAK|respondent_identifier|password/);
  const proposal = EC.normalizeAiResult({
    criteria: [{
      type: 'inclusion', statement: 'Lives in the study area',
      rationale: 'Matches the target population', uncertainty: 'Residence definition is needed'
    }],
    overall_warnings: ['Researcher review required']
  });
  assert.equal(proposal.criteria[0].source, 'ai_proposal');
  assert.equal(proposal.criteria[0].researcher_disposition, 'pending');
  assert.equal(proposal.overall_warnings.length, 1);
});

test('study constructor requires context preview and human criterion selection', () => {
  assert.match(constructor, /eligibility-criteria\.js/);
  assert.match(constructor, /ai-router\.js/);
  assert.match(constructor, /aiContextPreview/);
  assert.match(constructor, /aiContextApproved/);
  assert.match(constructor, /sendRequestDetailed\('study_design'/);
  assert.match(constructor, /accepted_criterion_ids/);
  assert.match(constructor, /human_disposition/);
  assert.match(constructor, /nothing is saved silently|скрытой записи нет|no se guarda nada de forma oculta/);
  assert.match(constructor, /сам критерий никого автоматически не исключает/);
  assert.match(apiSource, /Structured eligibility criteria must match the legacy criterion lists/);
  assert.match(apiSource, /eligibility_ai_reviews must contain complete AI provenance/);
  assert.match(settings, /task_study_design/);
});

test('server AI gateway accepts the allow-listed study design task for researchers', async () => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key';
  process.env.GROQ_API_KEY = 'server-only-test-key';
  const handler = (await import(
    `data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}#eligibility-ai`
  )).default;
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return {
      ok: true, status: 200, json: async () => [{
        session_id: '83ca8b34-acde-45be-a279-8188edaa8a05',
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null
      }]
    };
    if (call === 2) return {
      ok: true, status: 200, json: async () => [{
        account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329',
        username: 'owner', user_identifier: 'OWNER-001', role: 'researcher', status: 'active'
      }]
    };
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"criteria":[{"type":"inclusion","statement":"Adult","rationale":"Target population"}],"overall_warnings":[]}' } }] })
    };
  };
  try {
    const res = {
      statusCode: 200, payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; }
    };
    await handler({
      method: 'POST', url: '/api/ai/request',
      headers: { host: 'research-os.test', authorization: 'Bearer researcher-token' },
      body: {
        task: 'study_design', provider: 'groq', model: 'openai/gpt-oss-20b',
        system_prompt: 'Return protocol-level JSON only.', payload: { objective: 'Describe outcome' }
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.task, 'study_design');
    assert.equal(res.payload.provider, 'groq');
    assert.equal(res.payload.result.criteria[0].statement, 'Adult');
    assert.equal(call, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
