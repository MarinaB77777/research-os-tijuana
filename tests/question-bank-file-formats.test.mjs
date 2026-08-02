import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const importerSource = await fs.readFile(new URL('question-bank-import.js', root), 'utf8');
const importerContext = {
  crypto: webcrypto,
  Uint8Array,
  TextDecoder,
  console
};
importerContext.globalThis = importerContext;
vm.runInNewContext(importerSource, importerContext);
const importer = importerContext.QuestionBankImport;

const JSZip = require('../vendor/jszip.min.js');
const mammoth = require('../vendor/mammoth.browser.min.js');
const pdfjs = require('../vendor/pdf.min.js');
const yaml = require('../vendor/js-yaml.min.js');

const xlsxContext = { console, Uint8Array, ArrayBuffer, Buffer, setTimeout, clearTimeout };
xlsxContext.globalThis = xlsxContext;
xlsxContext.window = xlsxContext;
xlsxContext.self = xlsxContext;
const xlsxSource = (await Promise.all([
  fs.readFile(new URL('vendor/xlsx.full.min.js.part-00', root), 'utf8'),
  fs.readFile(new URL('vendor/xlsx.full.min.js.part-01', root), 'utf8')
])).join('');
vm.runInNewContext(xlsxSource, xlsxContext);
const XLSX = xlsxContext.XLSX;

const readerSource = await fs.readFile(new URL('question-bank-file-reader.js', root), 'utf8');
const readerContext = {
  console, Uint8Array, ArrayBuffer, TextDecoder, Blob, URL, XLSX,
  QuestionBankImport: importer
};
readerContext.globalThis = readerContext;
readerContext.window = readerContext;
vm.runInNewContext(readerSource, readerContext);
const fileReader = readerContext.QuestionBankFileReader;

const questionnaireText = [
  '1. ¿Cómo está hoy?',
  '1) Mal',
  '2) Bien',
  '',
  '2. ¿Dónde trabaja?',
  'a) Laboratorio',
  'b) Oficina'
].join('\n');

const rows = [
  { code: 'Q_1', prompt: '¿Cómo está hoy?', option_value: 1, option_text: 'Mal' },
  { code: 'Q_1', prompt: '¿Cómo está hoy?', option_value: 2, option_text: 'Bien' },
  { code: 'Q_2', prompt: '¿Dónde trabaja?', option_value: 'a', option_text: 'Laboratorio' },
  { code: 'Q_2', prompt: '¿Dónde trabaja?', option_value: 'b', option_text: 'Oficina' }
];

function assertUsableQuestionnaire(bank) {
  assert.equal(bank.question_order.length, 2);
  assert.equal(bank.questions.Q_1.prompt, '¿Cómo está hoy?');
  assert.deepEqual(
    JSON.parse(JSON.stringify(bank.questions.Q_1.options.map(option => option.text))),
    ['Mal', 'Bien']
  );
  assert.equal(importer.summarize(bank, 'fixture').can_use, true);
}

function rowsBank(value) {
  return importer.rowsToQuestionBank(value, {
    title: 'Cuestionario de prueba',
    interface_language: 'es'
  });
}

async function makeDocx(text) {
  const archive = new JSZip();
  archive.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  );
  archive.folder('_rels').file(
    '.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="word/document.xml"/>' +
    '</Relationships>'
  );
  const paragraphs = text.split('\n').map(line =>
    `<w:p><w:r><w:t xml:space="preserve">${line
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')}</w:t></w:r></w:p>`
  ).join('');
  archive.folder('word').file(
    'document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${paragraphs}<w:sectPr/></w:body>` +
    '</w:document>'
  );
  return archive.generateAsync({ type: 'nodebuffer' });
}

function makePdf(lines) {
  const escapePdf = value => value.replace(/([\\()])/g, '\\$1');
  const stream = [
    'BT',
    '/F1 12 Tf',
    '72 760 Td',
    ...lines.flatMap((line, index) =>
      index
        ? ['0 -20 Td', `(${escapePdf(line)}) Tj`]
        : [`(${escapePdf(line)}) Tj`]
    ),
    'ET'
  ].join('\n');
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  ];
  let output = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = output.length;
    output = Buffer.concat([
      output,
      Buffer.from(`${index} 0 obj\n${objects[index]}\nendobj\n`, 'latin1')
    ]);
  }
  const xrefOffset = output.length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  return Buffer.concat([
    output,
    Buffer.from(
      `${xref}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
      'latin1'
    )
  ]);
}

async function extractPdf(pdfBytes) {
  const document = await pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true
  }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(importer.pdfItemsToText(content.items));
  }
  return pages.join('\n');
}

test.before(async () => {
  const workerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'research-os-pdf-worker-'));
  const workerPath = path.join(workerDirectory, 'pdf.worker.js');
  const workerSource = (await Promise.all([
    fs.readFile(new URL('vendor/pdf.worker.min.js.part-00', root), 'utf8'),
    fs.readFile(new URL('vendor/pdf.worker.min.js.part-01', root), 'utf8')
  ])).join('');
  await fs.writeFile(workerPath, workerSource);
  pdfjs.GlobalWorkerOptions.workerSrc = workerPath;
});

test('JSON, YAML, Python, and TXT files become the canonical questionnaire format', () => {
  const structured = { title: 'Cuestionario de prueba', questions: {
    Q_1: {
      prompt: '¿Cómo está hoy?',
      response_type: 'single_select',
      answer_options: ['Mal', 'Bien'],
      scale: 'single_choice'
    },
    Q_2: {
      prompt: '¿Dónde trabaja?',
      response_type: 'single_select',
      answer_options: ['Laboratorio', 'Oficina'],
      scale: 'single_choice'
    }
  } };
  const sources = [
    JSON.stringify(structured),
    yaml.dump(structured),
    `QUESTION_BANK = ${JSON.stringify(structured)}`
  ];
  sources.forEach(sourceText => {
    const parsed = importer.parseStructuredText(sourceText, value => yaml.load(value));
    assertUsableQuestionnaire(importer.canonicalOrConverted(parsed));
  });
  assertUsableQuestionnaire(importer.plainTextToQuestionBank(
    questionnaireText,
    { title: 'Cuestionario de prueba' }
  ));
});

test('real UTF-8 CSV and binary XLSX preserve Spanish text and ordered options', () => {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Preguntas');

  const csvBytes = new TextEncoder().encode(XLSX.utils.sheet_to_csv(worksheet));
  const csvText = importer.decodeTextBytes(csvBytes);
  const csvWorkbook = XLSX.read(csvText, { type: 'string', codepage: 65001 });
  assertUsableQuestionnaire(rowsBank(
    XLSX.utils.sheet_to_json(csvWorkbook.Sheets[csvWorkbook.SheetNames[0]], { defval: null })
  ));

  const xlsxBytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const binaryWorkbook = XLSX.read(xlsxBytes, { type: 'array' });
  assertUsableQuestionnaire(rowsBank(
    XLSX.utils.sheet_to_json(
      binaryWorkbook.Sheets[binaryWorkbook.SheetNames[0]],
      { defval: null }
    )
  ));
});

test('headerless CSV keeps its first question and enters editable plain-questionnaire parsing', async () => {
  const bytes = new TextEncoder().encode('1. Age\n2. Gender\n3. Country');
  const result = await fileReader.readQuestionnaireFile({
    name: 'demographics.csv',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  });
  const bank = importer.plainTextToQuestionBank(result.content, { title: result.source_title });

  assert.equal(result.input_kind, 'plain');
  assert.match(result.content, /^1\. Age/m);
  assert.deepEqual(JSON.parse(JSON.stringify(bank.question_order)), ['Q_1', 'Q_2', 'Q_3']);
});

test('Spanish spreadsheet headers map to the same canonical row contract', async () => {
  const csv = [
    'código pregunta,pregunta,valor opción,opción,tipo,escala,nivel psicométrico',
    'Q_1,¿Cómo está?,1,Mal,single_select,single_choice,nominal',
    'Q_1,¿Cómo está?,2,Bien,single_select,single_choice,nominal'
  ].join('\n');
  const bytes = new TextEncoder().encode(csv);
  const result = await fileReader.readQuestionnaireFile({
    name: 'preguntas.csv',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  });
  const bank = importer.canonicalOrConverted(result.parsed_value, { title: result.source_title });

  assert.equal(result.input_kind, 'structured');
  assert.equal(bank.questions.Q_1.prompt, '¿Cómo está?');
  assert.deepEqual(JSON.parse(JSON.stringify(bank.questions.Q_1.options.map(option => option.text))), ['Mal', 'Bien']);
  assert.equal(importer.summarize(bank, 'csv').can_use, true);
});

test('equal generated codes on separate workbook sheets remain separate questions', () => {
  const bank = rowsBank([
    { __source_sheet: 'Wave 1', code: 'Q_1', prompt: 'First wave?', type: 'text_input', scale: { id: 'text', psychometric_level: 'textual' } },
    { __source_sheet: 'Wave 2', code: 'Q_1', prompt: 'Second wave?', type: 'text_input', scale: { id: 'text', psychometric_level: 'textual' } }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(bank.question_order)), ['Q_1', 'Q_1_2']);
  assert.equal(bank.questions.Q_1.prompt, 'First wave?');
  assert.equal(bank.questions.Q_1_2.prompt, 'Second wave?');
});

test('the constructor own Excel XML export reopens as the same ordered bank rows', async () => {
  const [constructorPage, contractsSource] = await Promise.all([
    fs.readFile(new URL('constructor_quest.html', root), 'utf8'),
    fs.readFile(new URL('research-contracts.js', root), 'utf8')
  ]);
  const inlineSource = [...constructorPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .find(value => value.includes('function buildExcelXml'));
  const storage = new Map();
  const exportContext = {
    crypto: webcrypto, console, URL, Headers, Blob, TextEncoder, TextDecoder, Uint8Array,
    setTimeout, clearTimeout, alert() {}, confirm() { return true; }, document: {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    sessionStorage: { getItem: () => null, removeItem() {} }
  };
  exportContext.window = exportContext;
  exportContext.globalThis = exportContext;
  exportContext.window.addEventListener = () => {};
  vm.createContext(exportContext);
  vm.runInContext(contractsSource, exportContext);
  vm.runInContext(`${inlineSource}\nglobalThis.exportBankXml=packageData=>buildFile(packageData,'xls').content;`, exportContext);
  const canonical = rowsBank(rows);
  const xml = exportContext.exportBankXml(canonical);
  const reopened = XLSX.read(xml, { type: 'string' });
  const reopenedRows = XLSX.utils.sheet_to_json(
    reopened.Sheets[reopened.SheetNames[0]],
    { defval: null }
  );
  const reopenedBank = rowsBank(reopenedRows);
  assertUsableQuestionnaire(reopenedBank);
  assert.deepEqual(
    JSON.parse(JSON.stringify(reopenedBank.questions.Q_2.options.map(option => option.value))),
    ['a', 'b']
  );
});

test('real DOCX, PDF, and PAGES-with-PDF-preview preserve question lines', async () => {
  const docx = await makeDocx(questionnaireText);
  const docxResult = await mammoth.extractRawText({
    arrayBuffer: docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength)
  });
  assertUsableQuestionnaire(importer.plainTextToQuestionBank(
    docxResult.value,
    { title: 'Cuestionario DOCX' }
  ));

  const pdf = makePdf(questionnaireText.split('\n').filter(Boolean));
  const pdfText = await extractPdf(pdf);
  assert.match(pdfText, /1\. ¿Cómo está hoy\?\n1\) Mal\n2\) Bien/);
  assertUsableQuestionnaire(importer.plainTextToQuestionBank(
    pdfText,
    { title: 'Cuestionario PDF' }
  ));

  const pages = new JSZip();
  pages.file('QuickLook/Preview.pdf', pdf);
  const pagesBytes = await pages.generateAsync({ type: 'nodebuffer' });
  const openedPages = await JSZip.loadAsync(pagesBytes);
  const previewEntry = Object.values(openedPages.files).find(entry =>
    !entry.dir && /(?:^|\/)(?:preview|Preview|QuickLook\/Preview)\.pdf$/i.test(entry.name)
  );
  assert.ok(previewEntry);
  const pagesText = await extractPdf(await previewEntry.async('uint8array'));
  assertUsableQuestionnaire(importer.plainTextToQuestionBank(
    pagesText,
    { title: 'Cuestionario PAGES' }
  ));
});
