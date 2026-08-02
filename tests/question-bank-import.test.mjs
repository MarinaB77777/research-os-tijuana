import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../question-bank-import.js', import.meta.url), 'utf8');
const context = {
  crypto: webcrypto,
  Uint8Array,
  TextDecoder,
  console
};
context.globalThis = context;
vm.runInNewContext(source, context);
const importer = context.QuestionBankImport;

const bank = {
  schema: 'research_os.question_bank',
  schema_version: 2,
  bank_id: '177ced8e-6b08-4df3-9d84-40735890640b',
  code: 'TEST_BANK',
  title: 'Test bank',
  version: 3,
  status: 'draft',
  primary_language: 'es-MX',
  interface_language: 'ru',
  global_mode: 'dynamic',
  global_time_reference: '2026-07-28T12:00:00.000Z',
  generated_at: '2026-07-28T12:00:00.000Z',
  question_order: ['Q_1'],
  questions: {
    Q_1: {
      question_id: '682a6069-65c2-42d3-9697-015f7b28104f',
      code: 'Q_1',
      version: 2,
      block: null,
      family: null,
      domain: 'physical',
      parameter: null,
      type: 'single_select',
      prompt: 'Question?',
      options: [
        { value: 0, text: 'No' },
        { value: 1, text: 'Yes' }
      ],
      scale: {
        id: 'binary',
        psychometric_level: 'nominal',
        min: 0,
        max: 1,
        step: 1,
        unit: null,
        direction: null
      },
      score_direction: null,
      time: { tracking_mode: 'time_invariant', wave: null, lag: null },
      status: 'draft'
    }
  }
};

function pythonLiteral(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const child = ' '.repeat(indent + 4);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return value.length
      ? `[\n${value.map(item => `${child}${pythonLiteral(item, indent + 4)}`).join(',\n')}\n${pad}]`
      : '[]';
  }
  const entries = Object.entries(value);
  return entries.length
    ? `{\n${entries.map(([key, item]) => `${child}${JSON.stringify(key)}: ${pythonLiteral(item, indent + 4)}`).join(',\n')}\n${pad}}`
    : '{}';
}

test('Python QUESTION_BANK import preserves the full canonical identity without executing code', () => {
  const text = `# Research OS contract\nQUESTION_BANK = ${pythonLiteral(bank)}\n`;
  const parsed = importer.parseStructuredText(text);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), bank);
  const result = importer.summarize(importer.canonicalOrConverted(parsed), 'py');
  assert.equal(result.can_use, true);
  assert.equal(result.bank.bank_id, bank.bank_id);
  assert.equal(result.bank.questions.Q_1.question_id, bank.questions.Q_1.question_id);
});

test('Python import rejects executable expressions', () => {
  assert.throws(
    () => importer.parseStructuredText('QUESTION_BANK = load_bank("secret.json")'),
    /Executable or unsupported token/
  );
});

test('structured source formats never fall back to question-mark line scraping', () => {
  assert.equal(importer.mayFallbackToPlainText('py'), false);
  assert.equal(importer.mayFallbackToPlainText('json'), false);
  assert.equal(importer.mayFallbackToPlainText('yaml'), false);
  assert.equal(importer.mayFallbackToPlainText('js'), false);
  assert.equal(importer.mayFallbackToPlainText('txt'), true);
  assert.equal(importer.mayFallbackToPlainText('text'), true);
});

test('legacy question_prompt, answer_options, and scale id are normalized without becoming literal prose', () => {
  const imported = importer.canonicalOrConverted({
    title: 'Legacy bank',
    questions: {
      Q_1: {
        question_prompt: 'Actual research question?',
        response_type: 'single_select',
        answer_options: ['No', 'Yes'],
        scale: 'binary',
        status: 'draft'
      }
    }
  });
  assert.equal(imported.questions.Q_1.prompt, 'Actual research question?');
  assert.deepEqual(
    JSON.parse(JSON.stringify(imported.questions.Q_1.options)),
    [{ value: 0, text: 'No' }, { value: 1, text: 'Yes' }]
  );
  assert.equal(imported.questions.Q_1.scale.id, 'binary');
  assert.equal(importer.summarize(imported, 'py').can_use, true);
});

test('synthetic Strict Cyan Protocol fixture preserves all variables, scales, routing, and unfinished prompts', async () => {
  const text = await fs.readFile(
    new URL('./fixtures/synthetic_strict_cyan_protocol.json', import.meta.url),
    'utf8'
  );
  const parsed = importer.parseStructuredText(text);
  const imported = importer.canonicalOrConverted(parsed);
  const result = importer.summarize(imported, 'json');

  assert.equal(result.counts.questions, 4);
  assert.deepEqual(
    JSON.parse(JSON.stringify(imported.question_order)),
    [
      'SYNTHETIC_CONTEXT_GROUP',
      'SYNTHETIC_LOAD_T1',
      'SYNTHETIC_METRIC',
      'SYNTHETIC_UNFINISHED_SCALE'
    ]
  );
  assert.equal(imported.title, 'Research OS Strict Cyan Protocol Engine');
  assert.equal(imported.version, 1);
  assert.equal(imported.source_contract.version, '2.6.0');
  assert.equal(imported.source_contract.psychometric_integrity, 'validated_strict');
  assert.equal(imported.primary_language, 'en-US');
  assert.equal(imported.global_mode, 'static');
  assert.equal(imported.global_time_reference, '2026-01-15T12:00:00.000Z');

  const contextGroup = imported.questions.SYNTHETIC_CONTEXT_GROUP;
  assert.equal(
    contextGroup.prompt,
    'Select a synthetic context group for this importer test:'
  );
  assert.equal(contextGroup.source_variable_id, 'synthetic_context_group');
  assert.equal(contextGroup.parameter, null);
  assert.equal(contextGroup.type, 'single_select');
  assert.equal(contextGroup.scale.id, 'single_choice');
  assert.equal(contextGroup.scale.psychometric_level, 'nominal');
  assert.equal(contextGroup.options.length, 3);
  assert.equal(contextGroup.options[0].value, 'alpha');
  assert.equal(contextGroup.options[0].target_transition, 'next');
  assert.equal(contextGroup.routing.default_next, 'next');

  const load = imported.questions.SYNTHETIC_LOAD_T1;
  assert.equal(load.scale.id, 'likert_7');
  assert.equal(load.time.tracking_mode, 'time_variant');
  assert.equal(load.time.wave, 'wave_1');
  assert.equal(load.time.lag, 'days_7');

  const numeric = imported.questions.SYNTHETIC_METRIC;
  assert.equal(numeric.type, 'number');
  assert.equal(numeric.scale.id, 'currency_metric');
  assert.equal(numeric.scale.min, 1);
  assert.equal(numeric.scale.max, 5);
  assert.equal(numeric.scale.step, 1);

  assert.equal(result.can_use, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      result.diagnostics
        .filter(item => item.code === 'PLACEHOLDER_PROMPT')
        .map(item => item.question_code)
    )),
    ['SYNTHETIC_METRIC', 'SYNTHETIC_UNFINISHED_SCALE']
  );
  assert.equal(
    result.diagnostics.filter(item => item.code === 'UNRESOLVED_TYPE').length,
    0
  );
  assert.equal(
    result.diagnostics.filter(item => item.code === 'UNRESOLVED_SCALE').length,
    0
  );
});

test('tabular export rows are grouped back into one question with ordered options', () => {
  const rows = [
    {
      bank_id: bank.bank_id,
      bank_code: bank.code,
      bank_title: bank.title,
      bank_version: 3,
      bank_status: 'draft',
      question_id: bank.questions.Q_1.question_id,
      code: 'Q_1',
      version: 2,
      type: 'single_select',
      prompt: 'Question?',
      option_value: 0,
      option_text: 'No',
      scale_id: 'binary',
      psychometric_level: 'nominal',
      status: 'draft',
      global_time_reference: bank.global_time_reference
    },
    {
      bank_id: bank.bank_id,
      bank_code: bank.code,
      bank_title: bank.title,
      bank_version: 3,
      bank_status: 'draft',
      question_id: bank.questions.Q_1.question_id,
      code: 'Q_1',
      version: 2,
      type: 'single_select',
      prompt: 'Question?',
      option_value: 1,
      option_text: 'Yes',
      scale_id: 'binary',
      psychometric_level: 'nominal',
      status: 'draft',
      global_time_reference: bank.global_time_reference
    }
  ];
  const imported = importer.rowsToQuestionBank(rows);
  assert.equal(imported.question_order.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(imported.questions.Q_1.options)),
    [{ value: 0, text: 'No' }, { value: 1, text: 'Yes' }]
  );
  assert.equal(importer.summarize(imported, 'xlsx').can_use, true);
});

test('unstructured research prose is previewed but cannot silently become a usable bank', () => {
  const text = [
    'T — Physical Resources',
    'Глубинный исследовательский вопрос:',
    'Насколько организм сохраняет способность функционировать?',
    'Пояснение:',
    'Физические ресурсы понимаются как способность организма восстанавливаться.'
  ].join('\n');
  const imported = importer.plainTextToQuestionBank(text, { title: 'Research questions' });
  const result = importer.summarize(imported, 'docx');
  assert.equal(result.counts.questions, 1);
  assert.equal(result.can_use, false);
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_TYPE'));
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_SCALE'));
});

test('bare numbered questionnaire becomes a canonical editable bank with inferred scales', () => {
  const text = [
    '1. How often do you recover fully after ordinary exertion?',
    '1) Never',
    '2) Rarely',
    '3) Sometimes',
    '4) Often',
    '5) Always',
    '',
    '2. Which environment do you work in most often?',
    'a) Laboratory',
    'b) Office',
    'c) Outdoors'
  ].join('\n');
  const imported = importer.plainTextToQuestionBank(text, { title: 'Bare questionnaire' });
  const result = importer.summarize(imported, 'txt');

  assert.equal(result.counts.questions, 2);
  assert.equal(result.can_use, true);
  assert.match(imported.questions.Q_1.question_id, /^[0-9a-f-]{36}$/i);
  assert.equal(imported.questions.Q_1.source_context.question_number, '1');
  assert.equal(imported.questions.Q_1.type, 'single_select');
  assert.equal(imported.questions.Q_1.scale.id, 'frequency_scale');
  assert.equal(imported.questions.Q_1.scale.psychometric_level, 'ordinal');
  assert.deepEqual(
    JSON.parse(JSON.stringify(imported.questions.Q_1.options.map(option => option.value))),
    [1, 2, 3, 4, 5]
  );
  assert.equal(imported.questions.Q_2.type, 'single_select');
  assert.equal(imported.questions.Q_2.scale.id, 'single_choice');
  assert.equal(imported.questions.Q_2.scale.psychometric_level, 'nominal');
});

test('an explicit bare numeric range is preserved without being mislabeled as Likert', () => {
  const text = [
    '1. Насколько выражена текущая нагрузка?',
    'Шкала: 1–5'
  ].join('\n');
  const imported = importer.plainTextToQuestionBank(text, { title: 'Numeric scale' });
  const question = imported.questions.Q_1;

  assert.equal(question.type, 'single_select');
  assert.equal(question.scale.id, 'ordinal_1_5');
  assert.equal(question.scale.psychometric_level, 'ordinal');
  assert.equal(question.scale.min, 1);
  assert.equal(question.scale.max, 5);
  assert.equal(question.scale.step, 1);
  assert.equal(question.options.length, 5);
  assert.equal(importer.summarize(imported, 'txt').can_use, true);
});

test('answer options without service fields or bullets are collected after an options heading', () => {
  const imported = importer.plainTextToQuestionBank([
    '1. ¿La condición está presente?',
    'Opciones:',
    'Sí',
    'No'
  ].join('\n'), { title: 'Headerless options' });
  const question = imported.questions.Q_1;

  assert.equal(question.type, 'single_select');
  assert.equal(question.scale.id, 'dichotomous');
  assert.deepEqual(
    JSON.parse(JSON.stringify(question.options)),
    [{ value: 1, text: 'Sí' }, { value: 2, text: 'No' }]
  );
});

test('UTF-8 CSV bytes preserve Spanish punctuation and accents', () => {
  const decoded = importer.decodeTextBytes(
    new TextEncoder().encode('code,prompt\nQ_1,¿Cómo está? Sí')
  );
  assert.equal(decoded, 'code,prompt\nQ_1,¿Cómo está? Sí');
});

test('PDF text items are reconstructed into visual lines before questionnaire parsing', () => {
  const extracted = importer.pdfItemsToText([
    { str: '1.', transform: [12, 0, 0, 12, 72, 760], width: 10, height: 12 },
    { str: '¿Cómo está?', transform: [12, 0, 0, 12, 88, 760], width: 72, height: 12 },
    { str: '1) Mal', transform: [12, 0, 0, 12, 72, 740], width: 34, height: 12 },
    { str: '2) Bien', transform: [12, 0, 0, 12, 72, 720], width: 39, height: 12 }
  ]);
  assert.equal(extracted, '1. ¿Cómo está?\n1) Mal\n2) Bien');
  const imported = importer.plainTextToQuestionBank(extracted, { title: 'PDF real' });
  assert.equal(imported.questions.Q_1.prompt, '¿Cómo está?');
  assert.deepEqual(
    JSON.parse(JSON.stringify(imported.questions.Q_1.options)),
    [{ value: 1, text: 'Mal' }, { value: 2, text: 'Bien' }]
  );
});

test('missing content remains empty while generated service identity stays valid', () => {
  const imported = importer.plainTextToQuestionBank(
    '1. Describe the factor that mattered most?',
    { title: 'Incomplete questionnaire' }
  );
  const question = imported.questions.Q_1;
  const result = importer.summarize(imported, 'txt');

  assert.match(imported.bank_id, /^[0-9a-f-]{36}$/i);
  assert.match(question.question_id, /^[0-9a-f-]{36}$/i);
  assert.equal(question.version, 1);
  assert.equal(question.type, null);
  assert.equal(question.scale, null);
  assert.equal(result.can_use, false);
});

test('constructor routes all file imports through preview and consumes only validated banks', async () => {
  const [constructor, page] = await Promise.all([
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../importer.html', import.meta.url), 'utf8')
  ]);
  assert.match(constructor, /importer\.html\?return=constructor_survey\.html/);
  assert.match(constructor, /consumeImportedBank\(\)/);
  assert.doesNotMatch(constructor, /accept="\.json,application\/json"/);
  assert.match(page, /\.docx,.pdf,.xlsx,.xls,.xml,.csv,.yml,.yaml,.txt,.json,.py,.js,.pages/);
  assert.match(page, /QuestionBankImport\.summarize/);
  assert.match(page, /renameImportedQuestion/);
  assert.match(page, /parseEditedOptions/);
  assert.match(page, /currentImportResult\.bank/);
  assert.match(page, /ResearchContracts\.requestJson\('\/question-banks\/save'/);
  assert.match(page, /research_os\.imported_question_bank\.v1/);
  assert.match(page, /Designed and built in collaboration with Ray AI/);
  assert.doesNotMatch(page, /Gemini AI/);
});

test('saved banks and questionnaire files return to their owning editors', async () => {
  const [cabinet, bankConstructor, questionnaireConstructor] = await Promise.all([
    fs.readFile(new URL('../survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8')
  ]);
  assert.match(cabinet, /bank\.owned_by_current_account\?'constructor_quest\.html':'constructor_survey\.html'/);
  assert.match(bankConstructor, /loadRegisteredBankForEditing/);
  assert.match(bankConstructor, /questionBankPackageToEditor/);
  assert.match(bankConstructor, /ResearchContracts\.flattenQuestionBank\(packageData\)/);
  assert.match(questionnaireConstructor, /accept="\.json,\.questionnaire\.json,application\/json"/);
  assert.match(questionnaireConstructor, /stateFromQuestionnairePackage/);
  assert.match(questionnaireConstructor, /applyQuestionnairePackage/);
  assert.match(questionnaireConstructor, /buildPackage\(\);RC\.writeJson\(DRAFT_KEY,state\)/);
});

test('question-bank editor reopens and rebuilds canonical identity without changing scientific fields', async () => {
  const [contractsSource, constructorPage] = await Promise.all([
    fs.readFile(new URL('../research-contracts.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_quest.html', import.meta.url), 'utf8')
  ]);
  const inlineSource = [...constructorPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .find(value => value.includes('function buildQuestionBankPackage'));
  const storage = new Map();
  const roundTripContext = {
    crypto: webcrypto,
    console,
    URL,
    Headers,
    Blob,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    alert() {},
    confirm() { return true; },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    sessionStorage: { getItem: () => null, removeItem() {} },
    document: {}
  };
  roundTripContext.window = roundTripContext;
  roundTripContext.globalThis = roundTripContext;
  roundTripContext.window.addEventListener = () => {};
  vm.createContext(roundTripContext);
  vm.runInContext(contractsSource, roundTripContext);
  vm.runInContext(`${inlineSource}\n` +
    `globalThis.roundTripBank = packageData => {` +
    `const restored=questionBankPackageToEditor(packageData);` +
    `bank=restored.questions;bankMetadata=restored.metadata;currentMode=restored.mode;` +
    `return buildQuestionBankPackage();};`, roundTripContext);

  const reopened = roundTripContext.roundTripBank(bank);
  const originalQuestion = bank.questions.Q_1;
  const reopenedQuestion = reopened.questions.Q_1;
  assert.equal(reopened.bank_id, bank.bank_id);
  assert.equal(reopened.version, bank.version);
  assert.equal(reopened.global_time_reference, bank.global_time_reference);
  assert.equal(reopened.primary_language, bank.primary_language);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.question_order)), bank.question_order);
  for (const field of ['question_id', 'version', 'block', 'family', 'domain', 'parameter', 'type', 'prompt', 'options', 'scale', 'score_direction', 'time', 'status']) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(reopenedQuestion[field])),
      JSON.parse(JSON.stringify(originalQuestion[field])),
      field
    );
  }
});

test('questionnaire JSON reopening preserves item identities, routing, consent, and time reference', async () => {
  const [contractsSource, constructorPage] = await Promise.all([
    fs.readFile(new URL('../research-contracts.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8')
  ]);
  const inlineSource = [...constructorPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .find(value => value.includes('function stateFromQuestionnairePackage'));
  const packageData = {
    schema: 'research_os.questionnaire', schema_version: 1,
    questionnaire_id: '2ed5f06b-bb82-4d39-bc1f-557f5b07cb71', code: 'QNR', title: 'Questionnaire',
    description: 'Purpose', version: 2, status: 'draft', primary_language: 'es-MX',
    global_time_reference: '2026-08-01T12:00:00.000Z',
    consent: { mode: 'standard', consent_id: '00000000-0000-4000-8000-000000000001', consent_version: 1 },
    completion_policy: { minimum_answered_items: 1, require_terminal_route: true },
    start_item_id: 'ea5aa752-536e-44de-9097-63e81c411aa7',
    items: [
      { item_id: 'ea5aa752-536e-44de-9097-63e81c411aa7', position: 1, source_bank_id: bank.bank_id, source_bank_version: 3, source_bank_code: bank.code, question_id: bank.questions.Q_1.question_id, question_version: 2, code: 'Q_1', required: true, definition_snapshot: bank.questions.Q_1 },
      { item_id: '415a14aa-7a79-488f-897d-cc49eeafcd55', position: 2, source_bank_id: bank.bank_id, source_bank_version: 3, source_bank_code: bank.code, question_id: bank.questions.Q_1.question_id, question_version: 2, code: 'Q_1_REPEAT', required: false, definition_snapshot: bank.questions.Q_1 }
    ],
    routing: { nodes: {
      'ea5aa752-536e-44de-9097-63e81c411aa7': { default_target: '415a14aa-7a79-488f-897d-cc49eeafcd55', rules: [{ rule_id: '5082d6cf-d16b-4564-9338-cf69e84c57b0', operator: 'equals', value: 0, target: 'end' }] },
      '415a14aa-7a79-488f-897d-cc49eeafcd55': { default_target: 'end', rules: [] }
    } }
  };
  const questionnaireContext = {
    crypto: webcrypto, console, URL, Headers, Blob, TextEncoder, TextDecoder, Uint8Array,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {} }
  };
  questionnaireContext.window = questionnaireContext;
  questionnaireContext.globalThis = questionnaireContext;
  vm.createContext(questionnaireContext);
  vm.runInContext(contractsSource, questionnaireContext);
  vm.runInContext(`${inlineSource}\nglobalThis.restoreQuestionnaire=stateFromQuestionnairePackage;`, questionnaireContext);
  const restored = questionnaireContext.restoreQuestionnaire(packageData);
  assert.equal(restored.questionnaire_id, packageData.questionnaire_id);
  assert.equal(restored.global_time_reference, packageData.global_time_reference);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.consent)), packageData.consent);
  assert.deepEqual(restored.items.map(item => item.item_id), packageData.items.map(item => item.item_id));
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.items[0].rules)),
    packageData.routing.nodes[packageData.start_item_id].rules
  );
  assert.equal(restored.items[0].default_target, packageData.items[1].item_id);
});

test('multi-format readers are local and the editing workspace stays compact', async () => {
  const [page, reader] = await Promise.all([
    fs.readFile(new URL('../importer.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../question-bank-file-reader.js', import.meta.url), 'utf8')
  ]);
  const localAssets = [
    '../vendor/mammoth.browser.min.js',
    '../vendor/pdf.min.js',
    '../vendor/pdf.worker.min.js.part-00',
    '../vendor/pdf.worker.min.js.part-01',
    '../vendor/xlsx.full.min.js.part-00',
    '../vendor/xlsx.full.min.js.part-01',
    '../vendor/js-yaml.min.js',
    '../vendor/jszip.min.js',
    '../vendor/pdfjs/standard_fonts/LICENSE_FOXIT'
  ];

  await Promise.all(localAssets.map(asset => fs.access(new URL(asset, import.meta.url))));
  assert.doesNotMatch(page, /<script[^>]+https?:\/\//i);
  assert.match(page, /question-bank-file-reader\.js/);
  assert.match(page, /QuestionBankFileReader\.readQuestionnaireFile/);
  assert.match(reader, /ensurePdfWorker/);
  assert.match(reader, /ensureXlsxLibrary/);
  assert.match(reader, /standardFontDataUrl: 'vendor\/pdfjs\/standard_fonts\/'/);
  assert.match(reader, /QuestionBankImport\.pdfItemsToText\(content\.items\)/);
  assert.match(reader, /QuestionBankImport\.decodeTextBytes\(await file\.arrayBuffer\(\)\)/);
  assert.match(reader, /XLSX\.read\(decoded,\s*\{\s*type:\s*'string',\s*codepage:\s*65001\s*\}\)/);
  assert.doesNotMatch(page, /currentParsedValue\s*\?\?/);
  assert.match(page, /currentParsedValue = null;[\s\S]*addEventListener\('input'/);
  assert.match(page, /id="ui-back-hub">← Volver al inicio/);
  assert.match(page, /UNRESOLVED_SCALE:\s*"Seleccione el contrato de escala/);
  assert.match(page, /height:\s*280px/);
  assert.match(page, /max-height:\s*500px/);
  assert.match(page, /textarea::\-webkit-scrollbar\s*\{[\s\S]*?width:\s*14px/);
  assert.match(page, /\.preview-questions::\-webkit-scrollbar\s*\{[\s\S]*?width:\s*14px/);
  assert.match(page, /scrollbar-color:\s*var\(--accent-color\)\s+#111827/);
});
