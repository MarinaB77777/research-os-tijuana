import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('all question-bank file consumers use one local multi-format reader', async () => {
  const paths = [
    '../importer.html',
    '../analyzer.html',
    '../translator.html',
    '../validator.html',
    '../constructor_parameter.html'
  ];
  const [reader, ...pages] = await Promise.all([
    fs.readFile(new URL('../question-bank-file-reader.js', import.meta.url), 'utf8'),
    ...paths.map(path => fs.readFile(new URL(path, import.meta.url), 'utf8'))
  ]);
  for (const page of pages) {
    assert.match(page, /question-bank-file-reader\.js/);
    assert.match(page, /QuestionBankFileReader\.readQuestionnaireFile/);
  }
  assert.match(reader, /'docx', 'pdf', 'xlsx', 'xls', 'xml', 'csv', 'yml', 'yaml', 'txt', 'json', 'py', 'js', 'pages'/);
  assert.match(reader, /extension === 'xml'/);
  assert.match(reader, /vendor\/xlsx\.full\.min\.js\.part-00/);
  assert.match(reader, /vendor\/pdf\.worker\.min\.js\.part-00/);
  assert.match(reader, /workbook\.SheetNames\.map/);
  assert.match(reader, /__source_sheet/);
  assert.ok(reader.includes('QuickLook\\/Preview'));
});

test('validator no longer depends on internet CDNs for file parsing', async () => {
  const validator = await fs.readFile(new URL('../validator.html', import.meta.url), 'utf8');
  assert.doesNotMatch(validator, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/);
  assert.match(validator, /vendor\/mammoth\.browser\.min\.js/);
  assert.match(validator, /vendor\/pdf\.min\.js/);
  assert.match(validator, /vendor\/js-yaml\.min\.js/);
});

test('researcher cabinet delegates file import instead of maintaining another parser', async () => {
  const cabinet = await fs.readFile(new URL('../survey.html', import.meta.url), 'utf8');
  assert.match(cabinet, /importer\.html\?return=survey\.html/);
  assert.doesNotMatch(cabinet, /FileReader|file\.text\(|JSON\.parse\(text\)/);
});
