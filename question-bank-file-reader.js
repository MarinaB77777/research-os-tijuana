(function (global) {
  'use strict';

  const ACCEPTED_EXTENSIONS = Object.freeze([
    'docx', 'pdf', 'xlsx', 'xls', 'xml', 'csv', 'yml', 'yaml', 'txt', 'json', 'py', 'js', 'pages'
  ]);
  const localLibraryPromises = {};
  let pdfWorkerObjectUrl = null;

  function extensionOf(fileName) {
    return String(fileName || '').split('.').pop().toLowerCase();
  }

  function sourceTitleOf(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  }

  async function loadLocalTextParts(paths) {
    const responses = await Promise.all(paths.map(path => fetch(path)));
    const failed = responses.find(response => !response.ok);
    if (failed) throw new Error(`Local file-reading library could not be loaded: ${failed.url}`);
    return (await Promise.all(responses.map(response => response.text()))).join('');
  }

  function ensureXlsxLibrary() {
    if (typeof global.XLSX !== 'undefined') return Promise.resolve();
    if (!localLibraryPromises.xlsx) {
      localLibraryPromises.xlsx = loadLocalTextParts([
        'vendor/xlsx.full.min.js.part-00',
        'vendor/xlsx.full.min.js.part-01'
      ]).then(source => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        script.src = objectUrl;
        script.onload = () => {
          URL.revokeObjectURL(objectUrl);
          typeof global.XLSX !== 'undefined'
            ? resolve()
            : reject(new Error('Local XLSX library did not initialize.'));
        };
        script.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Local XLSX library could not be initialized.'));
        };
        document.head.appendChild(script);
      }));
    }
    return localLibraryPromises.xlsx;
  }

  function ensurePdfWorker() {
    if (typeof global.pdfjsLib === 'undefined') {
      return Promise.reject(new Error('Local PDF library is not loaded.'));
    }
    if (pdfWorkerObjectUrl) return Promise.resolve();
    if (!localLibraryPromises.pdfWorker) {
      localLibraryPromises.pdfWorker = loadLocalTextParts([
        'vendor/pdf.worker.min.js.part-00',
        'vendor/pdf.worker.min.js.part-01'
      ]).then(source => {
        pdfWorkerObjectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        global.pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerObjectUrl;
      });
    }
    return localLibraryPromises.pdfWorker;
  }

  async function extractPdfText(arrayBuffer) {
    await ensurePdfWorker();
    const loadingTask = global.pdfjsLib.getDocument({
      data: arrayBuffer,
      standardFontDataUrl: 'vendor/pdfjs/standard_fonts/'
    });
    const pdfDocument = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(global.QuestionBankImport.pdfItemsToText(content.items));
    }
    return pages.join('\n');
  }

  function workbookRows(workbook) {
    const sheets = workbook.SheetNames.map(sheetName => ({
      sheet_name: sheetName,
      rows: global.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null })
    }));
    if (sheets.length === 1) return { rows: sheets[0].rows, sheet_names: [sheets[0].sheet_name] };
    return {
      rows: sheets.flatMap(sheet => sheet.rows.map(row => ({ ...row, __source_sheet: sheet.sheet_name }))),
      sheet_names: sheets.map(sheet => sheet.sheet_name)
    };
  }

  async function readQuestionnaireFile(file) {
    if (!file) throw new Error('A source file is required.');
    const extension = extensionOf(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      throw new Error(`Unsupported questionnaire file extension: .${extension || '?'}`);
    }
    let content = '';
    let parsedValue = null;
    let inputKind = 'structured';
    let sheetNames = [];

    if (extension === 'docx') {
      if (typeof global.mammoth === 'undefined') throw new Error('Local DOCX library is not loaded.');
      const result = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      content = result.value;
      inputKind = 'plain';
    } else if (extension === 'pdf') {
      content = await extractPdfText(await file.arrayBuffer());
      inputKind = 'plain';
    } else if (extension === 'xlsx' || extension === 'xls') {
      await ensureXlsxLibrary();
      const workbook = global.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const extracted = workbookRows(workbook);
      parsedValue = extracted.rows;
      sheetNames = extracted.sheet_names;
      content = JSON.stringify(parsedValue, null, 2);
    } else if (extension === 'xml') {
      await ensureXlsxLibrary();
      const decoded = global.QuestionBankImport.decodeTextBytes(await file.arrayBuffer());
      const workbook = global.XLSX.read(decoded, { type: 'string' });
      const extracted = workbookRows(workbook);
      parsedValue = extracted.rows;
      sheetNames = extracted.sheet_names;
      content = JSON.stringify(parsedValue, null, 2);
    } else if (extension === 'csv') {
      await ensureXlsxLibrary();
      const decoded = global.QuestionBankImport.decodeTextBytes(await file.arrayBuffer());
      const workbook = global.XLSX.read(decoded, { type: 'string', codepage: 65001 });
      const extracted = workbookRows(workbook);
      parsedValue = extracted.rows;
      sheetNames = extracted.sheet_names;
      content = JSON.stringify(parsedValue, null, 2);
    } else if (extension === 'pages') {
      if (typeof global.JSZip === 'undefined') throw new Error('Local PAGES/ZIP library is not loaded.');
      const archive = await global.JSZip.loadAsync(await file.arrayBuffer());
      const pdfEntry = Object.values(archive.files).find(entry =>
        !entry.dir && /(?:^|\/)(?:preview|Preview|QuickLook\/Preview)\.pdf$/i.test(entry.name)
      );
      if (!pdfEntry) {
        throw new Error('This PAGES file has no embedded text PDF; export it as DOCX or PDF for complete extraction.');
      }
      content = await extractPdfText(await pdfEntry.async('arraybuffer'));
      inputKind = 'plain';
    } else {
      const bytes = await file.arrayBuffer();
      content = global.QuestionBankImport.decodeTextBytes(bytes);
      if (extension === 'yml' || extension === 'yaml') {
        if (typeof global.jsyaml === 'undefined') throw new Error('Local YAML library is not loaded.');
        parsedValue = global.jsyaml.load(content);
        content = JSON.stringify(parsedValue, null, 2);
      }
    }
    if (!String(content || '').trim()) throw new Error('The source file contains no extractable questionnaire content.');
    return {
      extension,
      source_title: sourceTitleOf(file.name),
      content,
      parsed_value: parsedValue,
      input_kind: inputKind,
      sheet_names: sheetNames
    };
  }

  function toCanonicalQuestionBank(result, metadata) {
    if (!result || typeof result !== 'object') throw new Error('A file-reading result is required.');
    let parsed = result.parsed_value;
    if (parsed === null || parsed === undefined) {
      try {
        parsed = global.QuestionBankImport.parseStructuredText(result.content);
      } catch (error) {
        const plainAllowed = ['docx', 'pdf', 'pages', 'txt'].includes(result.extension);
        if (!plainAllowed) throw error;
        return global.QuestionBankImport.plainTextToQuestionBank(result.content, {
          title: result.source_title,
          ...(metadata || {})
        });
      }
    }
    if (parsed?.schema === 'research_os.questionnaire') return JSON.parse(JSON.stringify(parsed));
    return global.QuestionBankImport.canonicalOrConverted(parsed, {
      title: result.source_title,
      ...(metadata || {})
    });
  }

  global.QuestionBankFileReader = Object.freeze({
    ACCEPTED_EXTENSIONS,
    readQuestionnaireFile,
    toCanonicalQuestionBank,
    extractPdfText
  });
})(typeof window !== 'undefined' ? window : globalThis);
