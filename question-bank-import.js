(function (global) {
  'use strict';

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const STATUS = new Set(['draft', 'trial', 'active']);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function code(value, fallback) {
    const normalized = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized || fallback;
  }

  class LiteralParser {
    constructor(source) {
      this.source = source;
      this.index = 0;
    }

    error(message) {
      throw new Error(`${message} at character ${this.index + 1}`);
    }

    skip() {
      while (this.index < this.source.length) {
        if (/\s/.test(this.source[this.index])) {
          this.index += 1;
          continue;
        }
        if (this.source[this.index] === '#') {
          while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
          continue;
        }
        if (this.source.slice(this.index, this.index + 2) === '//') {
          while (this.index < this.source.length && this.source[this.index] !== '\n') this.index += 1;
          continue;
        }
        break;
      }
    }

    parse() {
      this.skip();
      const value = this.value();
      this.skip();
      if (this.index !== this.source.length && this.source[this.index] === ';') {
        this.index += 1;
        this.skip();
      }
      if (this.index !== this.source.length) this.error('Unexpected content');
      return value;
    }

    value() {
      this.skip();
      const char = this.source[this.index];
      if (char === '{') return this.object();
      if (char === '[' || char === '(') return this.array(char);
      if (char === '"' || char === "'") return this.string();
      if (char === '-' || /\d/.test(char || '')) return this.number();
      return this.identifierValue();
    }

    string() {
      const quote = this.source[this.index++];
      let result = '';
      while (this.index < this.source.length) {
        const char = this.source[this.index++];
        if (char === quote) return result;
        if (char !== '\\') {
          result += char;
          continue;
        }
        if (this.index >= this.source.length) this.error('Unterminated escape');
        const escaped = this.source[this.index++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'" };
        if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
          result += simple[escaped];
        } else if (escaped === 'u') {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) this.error('Invalid Unicode escape');
          result += String.fromCharCode(parseInt(hex, 16));
          this.index += 4;
        } else {
          result += escaped;
        }
      }
      this.error('Unterminated string');
    }

    number() {
      const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) this.error('Invalid number');
      this.index += match[0].length;
      return Number(match[0]);
    }

    identifier() {
      const match = this.source.slice(this.index).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
      if (!match) this.error('Expected identifier');
      this.index += match[0].length;
      return match[0];
    }

    identifierValue() {
      const identifier = this.identifier();
      if (identifier === 'True' || identifier === 'true') return true;
      if (identifier === 'False' || identifier === 'false') return false;
      if (identifier === 'None' || identifier === 'null') return null;
      this.error(`Executable or unsupported token "${identifier}"`);
    }

    object() {
      const result = {};
      this.index += 1;
      this.skip();
      while (this.source[this.index] !== '}') {
        if (this.index >= this.source.length) this.error('Unterminated object');
        const key = this.source[this.index] === '"' || this.source[this.index] === "'"
          ? this.string()
          : this.identifier();
        this.skip();
        if (this.source[this.index] !== ':') this.error('Expected ":"');
        this.index += 1;
        result[key] = this.value();
        this.skip();
        if (this.source[this.index] === ',') {
          this.index += 1;
          this.skip();
          if (this.source[this.index] === '}') break;
        } else if (this.source[this.index] !== '}') {
          this.error('Expected "," or "}"');
        }
      }
      this.index += 1;
      return result;
    }

    array(open) {
      const close = open === '[' ? ']' : ')';
      const result = [];
      this.index += 1;
      this.skip();
      while (this.source[this.index] !== close) {
        if (this.index >= this.source.length) this.error('Unterminated array');
        result.push(this.value());
        this.skip();
        if (this.source[this.index] === ',') {
          this.index += 1;
          this.skip();
          if (this.source[this.index] === close) break;
        } else if (this.source[this.index] !== close) {
          this.error(`Expected "," or "${close}"`);
        }
      }
      this.index += 1;
      return result;
    }
  }

  function literalPayload(text) {
    const withoutBom = String(text || '').replace(/^\uFEFF/, '');
    let inString = false;
    let quote = '';
    let escaped = false;
    let depth = 0;
    for (let i = 0; i < withoutBom.length; i += 1) {
      const char = withoutBom[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (char === '\\') escaped = true;
        else if (char === quote) inString = false;
        continue;
      }
      if (char === '"' || char === "'") {
        inString = true;
        quote = char;
      } else if ('[{('.includes(char)) {
        depth += 1;
      } else if (']})'.includes(char)) {
        depth -= 1;
      } else if (char === '=' && depth === 0) {
        const prefix = withoutBom.slice(0, i).replace(/#.*$/gm, '').trim();
        if (/^(?:(?:const|let|var)\s+)?[A-Za-z_$][A-Za-z0-9_$]*$/.test(prefix)) {
          return withoutBom.slice(i + 1);
        }
      }
    }
    return withoutBom;
  }

  function parseLiteralDocument(text) {
    return new LiteralParser(literalPayload(text)).parse();
  }

  function parseStructuredText(text, yamlLoader) {
    const value = String(text || '').trim();
    if (!value) throw new Error('The imported file is empty.');
    try {
      return JSON.parse(value);
    } catch (_) {}
    try {
      return parseLiteralDocument(value);
    } catch (literalError) {
      if (typeof yamlLoader === 'function') {
        try {
          const yaml = yamlLoader(value);
          if (yaml && typeof yaml === 'object') return yaml;
        } catch (_) {}
      }
      throw literalError;
    }
  }

  function optionRows(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    return String(value).split(/\s*(?:\||;)\s*/).filter(Boolean);
  }

  function normalizeOptions(value) {
    return optionRows(value).map((item, index) => {
      if (item && typeof item === 'object') {
        return {
          value: Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : index,
          text: String(item.text ?? item.label ?? '')
        };
      }
      return { value: index, text: String(item) };
    });
  }

  function valueOrNull(value) {
    return value === '' || value === undefined ? null : value;
  }

  function numericOrNull(value) {
    if (value === '' || value === undefined || value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function questionFromTabularRows(rows, index) {
    const first = rows[0];
    const qCode = code(first.code || first.question_code || `Q_${index + 1}`, `Q_${index + 1}`);
    const options = rows
      .filter(row => valueOrNull(row.option_text) !== null || valueOrNull(row.option_value) !== null)
      .map((row, optionIndex) => ({
        value: valueOrNull(row.option_value) ?? optionIndex,
        text: String(valueOrNull(row.option_text) ?? '')
      }));
    const explicitOptions = options.length ? options : normalizeOptions(first.options || first.choices);
    return {
      question_id: UUID_V4.test(String(first.question_id || '')) ? first.question_id : uuid(),
      code: qCode,
      version: Math.max(1, Number(first.version || first.question_version) || 1),
      block: valueOrNull(first.block),
      family: valueOrNull(first.family),
      domain: valueOrNull(first.domain),
      parameter: valueOrNull(first.parameter),
      type: valueOrNull(first.type || first.response_type || first.question_type),
      prompt: String(first.prompt || first.question || first.text || '').trim(),
      options: explicitOptions,
      scale: {
        id: valueOrNull(first.scale_id || first.scale_type),
        psychometric_level: valueOrNull(first.psychometric_level),
        min: numericOrNull(first.scale_min ?? first.min),
        max: numericOrNull(first.scale_max ?? first.max),
        step: numericOrNull(first.scale_step ?? first.step),
        unit: valueOrNull(first.scale_unit || first.unit),
        direction: valueOrNull(first.scale_direction || first.direction)
      },
      score_direction: valueOrNull(first.score_direction),
      time: {
        tracking_mode: valueOrNull(first.tracking_mode) || 'time_invariant',
        wave: valueOrNull(first.wave),
        lag: valueOrNull(first.lag)
      },
      status: STATUS.has(first.status) ? first.status : 'draft'
    };
  }

  function rowsToQuestionBank(rows, metadata) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('The spreadsheet contains no data rows.');
    const normalizedRows = rows.filter(row => row && typeof row === 'object');
    const grouped = new Map();
    normalizedRows.forEach((row, index) => {
      const key = String(row.question_id || row.code || row.question_code || `ROW_${index + 1}`);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const questions = {};
    Array.from(grouped.values()).forEach((questionRows, index) => {
      const question = questionFromTabularRows(questionRows, index);
      let uniqueCode = question.code;
      let suffix = 2;
      while (questions[uniqueCode]) uniqueCode = `${question.code}_${suffix++}`;
      question.code = uniqueCode;
      questions[uniqueCode] = question;
    });
    const first = normalizedRows[0] || {};
    return newQuestionBank(questions, {
      title: metadata?.title || first.bank_title,
      code: metadata?.code || first.bank_code,
      bank_id: first.bank_id,
      version: first.bank_version,
      status: first.bank_status,
      global_time_reference: first.global_time_reference,
      primary_language: metadata?.primary_language,
      interface_language: metadata?.interface_language
    });
  }

  function extractPlainTextQuestions(text) {
    const clean = String(text || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      .replace(/\r/g, '');
    const lines = clean.split('\n').map(line => line.trim()).filter(Boolean);
    const candidates = [];
    let current = null;
    let awaitingQuestion = false;
    let collectingQuestion = false;
    const questionHeading = /^(?:глубинный\s+)?(?:исследовательский\s+)?вопрос\s*:|^(?:deep\s+)?research\s+question\s*:|^pregunta\s+(?:de\s+)?investigaci[oó]n\s*:/i;
    const explanationHeading = /^(?:пояснение|explanation|explicaci[oó]n)\s*:/i;
    const numberedQuestion = /^(?:q(?:uestion)?\s*)?\d+\s*[\.)-]\s+/i;
    const optionLine = /^(?:[-*•]\s+|[A-Za-zА-Яа-я\d]+\s*[\.)]\s+)/;

    lines.forEach(line => {
      if (questionHeading.test(line)) {
        awaitingQuestion = true;
        collectingQuestion = false;
        return;
      }
      if (explanationHeading.test(line)) {
        current = null;
        awaitingQuestion = false;
        collectingQuestion = false;
        return;
      }
      if (current && collectingQuestion) {
        current.prompt = `${current.prompt} ${line}`.replace(/\s+/g, ' ').trim();
        collectingQuestion = !line.includes('?');
        return;
      }
      const isQuestion = awaitingQuestion || line.includes('?') || numberedQuestion.test(line);
      if (isQuestion) {
        const prompt = line.replace(numberedQuestion, '').trim();
        if (prompt) {
          current = { prompt, options: [] };
          candidates.push(current);
          collectingQuestion = !line.includes('?');
        }
        awaitingQuestion = false;
        return;
      }
      if (current && optionLine.test(line)) {
        current.options.push(line.replace(optionLine, '').trim());
      }
    });
    return candidates;
  }

  function plainTextToQuestionBank(text, metadata) {
    const candidates = extractPlainTextQuestions(text);
    if (!candidates.length) {
      throw new Error('No explicit question candidates were found in the document.');
    }
    const questions = {};
    candidates.forEach((candidate, index) => {
      const qCode = `Q_${index + 1}`;
      questions[qCode] = {
        question_id: uuid(),
        code: qCode,
        version: 1,
        block: null,
        family: null,
        domain: null,
        parameter: null,
        type: null,
        prompt: candidate.prompt,
        options: normalizeOptions(candidate.options),
        scale: null,
        score_direction: null,
        time: {
          tracking_mode: 'time_invariant',
          wave: null,
          lag: null
        },
        status: 'draft'
      };
    });
    return newQuestionBank(questions, metadata);
  }

  function normalizeQuestionMap(input) {
    const source = input?.questions && !Array.isArray(input.questions) ? input.questions : input;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('The imported structure does not contain a question object.');
    }
    const questions = {};
    Object.entries(source).forEach(([key, raw], index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const qCode = code(raw.code || key, `Q_${index + 1}`);
      questions[qCode] = {
        ...clone(raw),
        question_id: UUID_V4.test(String(raw.question_id || '')) ? raw.question_id : uuid(),
        code: qCode,
        version: Math.max(1, Number(raw.version) || 1),
        block: valueOrNull(raw.block),
        family: valueOrNull(raw.family),
        domain: valueOrNull(raw.domain),
        parameter: valueOrNull(raw.parameter),
        type: valueOrNull(raw.type || raw.response_type || raw.question_type),
        prompt: String(raw.prompt || raw.question || raw.text || '').trim(),
        options: normalizeOptions(raw.options || raw.choices),
        scale: raw.scale && typeof raw.scale === 'object' ? clone(raw.scale) : null,
        score_direction: valueOrNull(raw.score_direction),
        time: raw.time && typeof raw.time === 'object'
          ? clone(raw.time)
          : { tracking_mode: 'time_invariant', wave: null, lag: null },
        status: STATUS.has(raw.status) ? raw.status : 'draft'
      };
    });
    if (!Object.keys(questions).length) throw new Error('The imported structure contains no question definitions.');
    return questions;
  }

  function newQuestionBank(questions, metadata) {
    const now = new Date().toISOString();
    const title = String(metadata?.title || '').trim();
    return {
      schema: 'research_os.question_bank',
      schema_version: 2,
      bank_id: UUID_V4.test(String(metadata?.bank_id || '')) ? metadata.bank_id : uuid(),
      code: code(metadata?.code || title, 'IMPORTED_BANK'),
      title,
      version: Math.max(1, Number(metadata?.version) || 1),
      status: STATUS.has(metadata?.status) ? metadata.status : 'draft',
      primary_language: metadata?.primary_language || 'es-MX',
      interface_language: metadata?.interface_language || 'es',
      global_mode: metadata?.global_mode || 'dynamic',
      global_time_reference: metadata?.global_time_reference || now,
      generated_at: now,
      question_order: Object.keys(questions),
      questions
    };
  }

  function canonicalOrConverted(value, metadata) {
    if (value?.schema === 'research_os.question_bank') return clone(value);
    if (Array.isArray(value)) return rowsToQuestionBank(value, metadata);
    return newQuestionBank(normalizeQuestionMap(value), {
      ...metadata,
      title: value?.title || metadata?.title,
      code: value?.code || metadata?.code,
      bank_id: value?.bank_id,
      version: value?.version,
      status: value?.status,
      primary_language: value?.primary_language || metadata?.primary_language,
      interface_language: value?.interface_language || metadata?.interface_language,
      global_mode: value?.global_mode,
      global_time_reference: value?.global_time_reference
    });
  }

  function validateQuestionBank(bank) {
    const diagnostics = [];
    function issue(level, codeName, message, questionCode) {
      diagnostics.push({ level, code: codeName, message, question_code: questionCode || null });
    }
    if (bank?.schema !== 'research_os.question_bank' || bank?.schema_version !== 2) {
      issue('error', 'INVALID_SCHEMA', 'research_os.question_bank schema version 2 is required.');
      return diagnostics;
    }
    if (!UUID_V4.test(String(bank.bank_id || ''))) issue('error', 'INVALID_BANK_ID', 'A valid bank UUID is required.');
    if (!bank.title) issue('error', 'MISSING_BANK_TITLE', 'The imported bank needs a title.');
    if (!bank.code) issue('error', 'MISSING_BANK_CODE', 'The imported bank needs a code.');
    if (!Array.isArray(bank.question_order) || !bank.questions || typeof bank.questions !== 'object') {
      issue('error', 'INVALID_QUESTION_COLLECTION', 'questions and question_order are required.');
      return diagnostics;
    }
    const seen = new Set();
    bank.question_order.forEach((questionCode, index) => {
      const question = bank.questions[questionCode];
      if (!question) {
        issue('error', 'MISSING_QUESTION', `Question ${questionCode} is absent from questions.`, questionCode);
        return;
      }
      if (seen.has(questionCode)) issue('error', 'DUPLICATE_ORDER', `Question ${questionCode} occurs more than once in question_order.`, questionCode);
      seen.add(questionCode);
      if (!UUID_V4.test(String(question.question_id || ''))) issue('error', 'INVALID_QUESTION_ID', 'A valid question UUID is required.', questionCode);
      if (question.code !== questionCode) issue('error', 'CODE_MISMATCH', 'Question key and code do not match.', questionCode);
      if (!String(question.prompt || '').trim()) issue('error', 'MISSING_PROMPT', `Question ${index + 1} has no prompt.`, questionCode);
      if (!question.type) issue('error', 'UNRESOLVED_TYPE', 'Response type must be selected before this question can be registered.', questionCode);
      const scaleResolved = question.scale && typeof question.scale === 'object' &&
        Object.values(question.scale).some(value => value !== null && value !== undefined && value !== '');
      if (!scaleResolved) issue('error', 'UNRESOLVED_SCALE', 'A scale contract must be selected before this question can be registered.', questionCode);
      if (!Array.isArray(question.options)) issue('error', 'INVALID_OPTIONS', 'Question options must be an array.', questionCode);
      if (!STATUS.has(question.status)) issue('error', 'INVALID_STATUS', 'Question status must be draft, trial, or active.', questionCode);
    });
    Object.keys(bank.questions).forEach(questionCode => {
      if (!seen.has(questionCode)) issue('error', 'UNORDERED_QUESTION', `Question ${questionCode} is not in question_order.`, questionCode);
    });
    return diagnostics;
  }

  function summarize(bank, sourceFormat) {
    const diagnostics = validateQuestionBank(bank);
    return {
      source_format: sourceFormat,
      bank,
      diagnostics,
      can_use: !diagnostics.some(item => item.level === 'error'),
      counts: {
        questions: Array.isArray(bank?.question_order) ? bank.question_order.length : 0,
        errors: diagnostics.filter(item => item.level === 'error').length,
        warnings: diagnostics.filter(item => item.level === 'warning').length
      }
    };
  }

  global.QuestionBankImport = Object.freeze({
    parseLiteralDocument,
    parseStructuredText,
    rowsToQuestionBank,
    extractPlainTextQuestions,
    plainTextToQuestionBank,
    canonicalOrConverted,
    validateQuestionBank,
    summarize
  });
})(typeof window !== 'undefined' ? window : globalThis);
