import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html = await fs.readFile(new URL('../translator.html', import.meta.url), 'utf8');
const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const source = inlineScripts.at(-1)[1];
const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      style: {},
      classList: { add() {}, remove() {} },
      innerText: '',
      value: id === 'targetLang' ? 'es-MX' : '',
      disabled: false
    });
  }
  return elements.get(id);
}
let storedSession = null;
const context = vm.createContext({
  console,
  crypto: webcrypto,
  TextEncoder,
  Uint8Array,
  Blob,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  alert() {},
  confirm() { return true; },
  sessionStorage: { getItem() { return storedSession; } },
  localStorage: {
    getItem() { return null; },
    setItem() {}
  },
  document: {
    documentElement: {},
    addEventListener() {},
    querySelectorAll() { return []; },
    getElementById(id) { return element(id); }
  },
  window: {
    QuestionBankImport: {
      parseStructuredText() {},
      canonicalOrConverted(value) { return value; }
    },
    ResearchContracts: {
      async requestJson(url) {
        if (url.startsWith('/question-translations/draft?')) return { draft: null };
        if (url === '/question-translations/draft') {
          return { draft: { draft_id: '19d2b819-dd71-4f27-a108-a24705a5a914' } };
        }
        if (url === '/question-translations/verify') {
          return {
            language_verification: {
              status: 'verified', method: 'research_os_language_evidence_v1',
              checked_at: '2026-08-10T04:25:38.127Z', failures: []
            }
          };
        }
        return { ok: true };
      }
    }
  },
  AIRouter: {
    getTaskConfig() {
      return { provider: 'groq', model: 'openai/gpt-oss-20b' };
    },
    async sendRequest() { return { items: [] }; }
  }
});
vm.runInContext(source, context);

function run(expression, values = {}) {
  Object.assign(context, values);
  return vm.runInContext(expression, context);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('canonical bank translation changes only allow-listed user-facing text and language', () => {
  const bank = {
    schema: 'research_os.question_bank',
    schema_version: 2,
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'RESOURCE_BANK',
    title: 'Resource bank',
    version: 3,
    status: 'draft',
    primary_language: 'en-US',
    global_time_reference: '2026-07-29T12:00:00.000Z',
    question_order: ['RESOURCE_1'],
    questions: {
      RESOURCE_1: {
        question_id: '682a6069-65c2-42d3-9697-015f7b28104f',
        code: 'RESOURCE_1',
        version: 2,
        prompt: 'How much energy do you have?',
        type: 'single_select',
        options: [
          { value: 0, text: 'None', target_transition: 'end' },
          { value: 5, text: 'A lot', target_transition: 'next' }
        ],
        scale: {
          id: 'resource_0_5',
          min: 0,
          max: 5,
          step: 1,
          direction: 'direct'
        },
        calculation_formula: 'mean(answer_values)',
        routing: { default_next: 'RESOURCE_2' },
        source_context: {
          explanation: 'Current subjective energy.',
          source_variable: 'R_PHYSICAL'
        }
      }
    }
  };

  const entries = plain(run('collectTranslationEntries(bank)', { bank }));
  assert.deepEqual(
    entries.map(entry => entry.path),
    [
      ['title'],
      ['questions', 'RESOURCE_1', 'prompt'],
      ['questions', 'RESOURCE_1', 'options', 0, 'text'],
      ['questions', 'RESOURCE_1', 'options', 1, 'text'],
      ['questions', 'RESOURCE_1', 'source_context', 'explanation']
    ]
  );

  const results = entries.map((entry, index) => ({
    id: entry.id,
    text: `Traducción ${index + 1}`,
    confidence: 0.95,
    notes: null
  }));
  const translated = plain(run(
    'applyTranslationResults(bank, entries, results, "es-MX")',
    { bank, entries, results }
  ));

  assert.equal(translated.primary_language, 'es-MX');
  assert.equal(translated.bank_id, bank.bank_id);
  assert.equal(translated.version, bank.version);
  assert.equal(translated.questions.RESOURCE_1.question_id, bank.questions.RESOURCE_1.question_id);
  assert.equal(translated.questions.RESOURCE_1.options[0].value, 0);
  assert.equal(translated.questions.RESOURCE_1.options[0].target_transition, 'end');
  assert.equal(translated.questions.RESOURCE_1.scale.id, 'resource_0_5');
  assert.equal(translated.questions.RESOURCE_1.calculation_formula, 'mean(answer_values)');
  assert.deepEqual(translated.questions.RESOURCE_1.routing, { default_next: 'RESOURCE_2' });
  assert.equal(
    run('structuralIntegrityPreserved(bank, translated, entries)', {
      bank,
      translated,
      entries
    }),
    true
  );

  translated.questions.RESOURCE_1.routing.default_next = 'end';
  assert.equal(
    run('structuralIntegrityPreserved(bank, translated, entries)', {
      bank,
      translated,
      entries
    }),
    false
  );
});

test('questionnaire translation preserves item identity, order, routing, and consent binding', () => {
  const questionnaire = {
    schema: 'research_os.questionnaire',
    schema_version: 1,
    questionnaire_id: '24b68c24-acde-49d0-8a16-6cfd95d19328',
    code: 'RESOURCE_SURVEY',
    title: 'Resource survey',
    description: 'Baseline measurement.',
    version: 4,
    status: 'trial',
    primary_language: 'en-US',
    global_time_reference: '2026-07-29T12:00:00.000Z',
    consent: {
      mode: 'special',
      consent_id: '58a7c431-acde-46d3-88b3-7bb1222ab587',
      consent_version: 2
    },
    start_item_id: '7cf4fd57-acde-4f52-b552-61ecaffbfb41',
    items: [{
      item_id: '7cf4fd57-acde-4f52-b552-61ecaffbfb41',
      position: 1,
      source_bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
      source_bank_version: 3,
      question_id: '682a6069-65c2-42d3-9697-015f7b28104f',
      question_version: 2,
      code: 'RESOURCE_1',
      definition_snapshot: {
        prompt: 'How much energy do you have?',
        type: 'single_select',
        options: [
          { value: 0, text: 'None' },
          { value: 5, text: 'A lot' }
        ],
        scale: { id: 'resource_0_5', min: 0, max: 5, step: 1 }
      }
    }],
    routing: {
      nodes: {
        '7cf4fd57-acde-4f52-b552-61ecaffbfb41': {
          default_target: 'end',
          rules: [{ value: 0, target: 'end' }]
        }
      }
    }
  };

  const entries = plain(run(
    'collectTranslationEntries(questionnaire)',
    { questionnaire }
  ));
  const results = entries.map(entry => ({
    id: entry.id,
    text: `ES: ${entry.text}`,
    confidence: 0.9,
    notes: null
  }));
  const translated = plain(run(
    'applyTranslationResults(questionnaire, entries, results, "es-MX")',
    { questionnaire, entries, results }
  ));

  assert.equal(translated.questionnaire_id, questionnaire.questionnaire_id);
  assert.equal(translated.version, 4);
  assert.deepEqual(translated.consent, questionnaire.consent);
  assert.equal(translated.items[0].item_id, questionnaire.items[0].item_id);
  assert.equal(translated.items[0].position, 1);
  assert.equal(translated.items[0].question_version, 2);
  assert.deepEqual(translated.routing, questionnaire.routing);
  assert.equal(
    run('structuralIntegrityPreserved(questionnaire, translated, entries)', {
      questionnaire,
      translated,
      entries
    }),
    true
  );
});

test('AI translation result must cover every requested field exactly once', () => {
  const sourceDocument = {
    schema: 'research_os.question_bank',
    primary_language: 'en-US',
    title: 'Title',
    questions: {}
  };
  const entries = plain(run(
    'collectTranslationEntries(sourceDocument)',
    { sourceDocument }
  ));
  const duplicate = [
    { id: 'T1', text: 'Título' },
    { id: 'T1', text: 'Otro título' }
  ];

  assert.throws(
    () => run(
      'applyTranslationResults(sourceDocument, entries, duplicate, "es-MX")',
      { sourceDocument, entries, duplicate }
    ),
    /duplicate field|cover exactly/
  );
  assert.throws(
    () => run(
      'applyTranslationResults(sourceDocument, entries, [], "es-MX")',
      { sourceDocument, entries }
    ),
    /cover exactly/
  );
});

test('translation batches retain complete question and response-scale context', () => {
  const bank = {
    schema: 'research_os.question_bank', primary_language: 'es-MX', title: 'Decisiones',
    questions: {
      CONTROL: {
        prompt: '¿Lo que ocurre en su vida depende de usted?', type: 'single_select',
        options: [{ value: 1, text: 'Nunca' }, { value: 5, text: 'Siempre' }],
        scale: { id: 'frequency_scale', min: 1, max: 5, step: 1 }
      }
    }
  };
  const entries = plain(run('collectTranslationEntries(bank)', { bank }));
  const batches = plain(run('translationBatches(entries)', { entries }));
  const questionItems = batches.flat().filter(item => item.question_code === 'CONTROL');
  assert.ok(questionItems.length >= 3);
  assert.ok(questionItems.every(item => item.context.prompt === bank.questions.CONTROL.prompt));
  assert.deepEqual(questionItems[0].context.response_options, bank.questions.CONTROL.options);
  assert.deepEqual(questionItems[0].context.scale, bank.questions.CONTROL.scale);
});

test('translation is blocked when source option values contradict declared scale bounds', () => {
  const bank = {
    schema: 'research_os.question_bank', primary_language: 'es-MX',
    questions: {
      OPTIMISM: {
        prompt: '¿Con qué frecuencia?', type: 'single_select',
        options: [1, 2, 3, 4, 5].map(value => ({ value, text: String(value) })),
        scale: { id: 'frequency_scale', min: 0, max: 10, step: 1 }
      }
    }
  };
  const issues = plain(run('validateSourceMeasurementContracts(bank)', { bank }));
  assert.deepEqual(issues.map(issue => issue.code), ['scale_option_bounds_mismatch']);
  assert.match(issues[0].message, /1–5.*0–10/);
});

test('plain-text fallback is limited to TXT and returns a canonical bank', () => {
  let fallbackCalls = 0;
  context.window.QuestionBankImport = {
    parseStructuredText() {
      throw new Error('not structured');
    },
    mayFallbackToPlainText(extension) {
      return extension === 'txt';
    },
    plainTextToQuestionBank(_text, metadata) {
      fallbackCalls += 1;
      return {
        schema: 'research_os.question_bank',
        schema_version: 2,
        title: metadata.title,
        questions: {}
      };
    },
    canonicalOrConverted(value) {
      return value;
    }
  };

  const parsed = plain(run(
    'parseStructuredDocument("1. Question?", "source.txt")'
  ));
  assert.equal(parsed.schema, 'research_os.question_bank');
  assert.equal(parsed.title, 'source');
  assert.equal(fallbackCalls, 1);
  assert.throws(
    () => run('parseStructuredDocument("not json", "source.json")'),
    /not structured/
  );
  assert.equal(fallbackCalls, 1);
});

test('download remains blocked until an authenticated researcher accepts the AI proposal', async () => {
  const bank = {
    schema: 'research_os.question_bank',
    schema_version: 2,
    bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
    code: 'TRANSLATION_REVIEW',
    title: 'Review title',
    version: 1,
    status: 'draft',
    primary_language: 'en-US',
    global_time_reference: '2026-07-29T12:00:00.000Z',
    question_order: ['Q_1'],
    questions: {
      Q_1: {
        question_id: '682a6069-65c2-42d3-9697-015f7b28104f',
        code: 'Q_1',
        version: 1,
        prompt: 'Review question?',
        type: 'single_select',
        options: [{ value: 0, text: 'No' }, { value: 1, text: 'Yes' }],
        scale: { id: 'binary', min: 0, max: 1, step: 1 }
      }
    }
  };
  context.AIRouter.sendRequest = async (_task, _prompt, payload) => ({
    items: payload.map(item => ({
      id: item.id,
      text: `ES: ${item.text}`,
      confidence: 0.92,
      notes: null
    }))
  });
  elements.clear();
  element('targetLang').value = 'es-MX';
  storedSession = null;
  await run('loadedDocument = bank; currentFileName = "bank.json"; startTranslation()', { bank });

  const pending = plain(run('translatedDocument.translation_provenance'));
  assert.equal(pending.prompt_version, 'canonical_questionnaire_translation_v3');
  assert.equal(pending.provider, 'groq');
  assert.equal(pending.model, 'openai/gpt-oss-20b');
  assert.equal(pending.source_identity.bank_id, bank.bank_id);
  assert.equal(pending.source_primary_language, 'en-US');
  assert.equal(pending.target_language, 'es-MX');
  assert.match(pending.source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(pending.human_disposition.status, 'pending');
  assert.equal(element('downloadBtn').disabled, true);

  await run('approveTranslation()');
  assert.equal(run('translatedDocument.translation_provenance.human_disposition.status'), 'pending');
  assert.equal(element('downloadBtn').disabled, true);

  run(`translatedEntries.forEach(entry => reviewTranslationField(entry.id, 'accepted'))`);
  await run('approveTranslation()');
  assert.equal(run('translatedDocument.translation_provenance.human_disposition.status'), 'pending');

  storedSession = JSON.stringify({
    role: 'researcher',
    account_id: 'a22cb0be-acde-42c4-86aa-a1c023b0c329'
  });
  await run('approveTranslation()');
  assert.equal(run('translatedDocument.translation_provenance.human_disposition.status'), 'accepted');
  assert.equal(
    run('translatedDocument.translation_provenance.human_disposition.researcher_account_id'),
    'a22cb0be-acde-42c4-86aa-a1c023b0c329'
  );
  assert.ok(run('translatedDocument.translation_provenance.human_disposition.field_reviews.every(review => review.status === "accepted")'));
  assert.equal(element('downloadBtn').disabled, false);
});
