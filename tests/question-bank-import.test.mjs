import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../question-bank-import.js', import.meta.url), 'utf8');
const context = {
  crypto: webcrypto,
  Uint8Array,
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

test('constructor routes all file imports through preview and consumes only validated banks', async () => {
  const [constructor, page] = await Promise.all([
    fs.readFile(new URL('../constructor_survey.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../importer.html', import.meta.url), 'utf8')
  ]);
  assert.match(constructor, /importer\.html\?return=constructor_survey\.html/);
  assert.match(constructor, /consumeImportedBank\(\)/);
  assert.doesNotMatch(constructor, /accept="\.json,application\/json"/);
  assert.match(page, /\.docx,.pdf,.xlsx,.xls,.csv,.yml,.yaml,.txt,.json,.py,.js,.pages/);
  assert.match(page, /QuestionBankImport\.summarize/);
  assert.match(page, /ResearchContracts\.requestJson\('\/question-banks\/save'/);
  assert.match(page, /research_os\.imported_question_bank\.v1/);
});
