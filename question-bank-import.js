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
        const extra = Object.fromEntries(
          Object.entries(item).filter(([key]) => !['value', 'text', 'label', 'next', 'target'].includes(key))
        );
        if (Object.prototype.hasOwnProperty.call(item, 'next')) extra.source_next = item.next;
        if (Object.prototype.hasOwnProperty.call(item, 'target')) extra.source_target = item.target;
        return {
          value: Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : index + 1,
          text: String(item.text ?? item.label ?? ''),
          ...extra
        };
      }
      return { value: index + 1, text: String(item) };
    });
  }

  function normalizeResponseType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const aliases = {
      number: 'numeric_input',
      numeric: 'numeric_input',
      integer: 'numeric_input',
      float: 'numeric_input',
      text: 'text_input',
      string: 'text_input',
      single_choice: 'single_select',
      radio: 'single_select',
      multiple_choice: 'multiple_select',
      checkbox: 'multiple_select'
    };
    return aliases[normalized] || valueOrNull(value);
  }

  function valueOrNull(value) {
    return value === '' || value === undefined ? null : value;
  }

  function numericOrNull(value) {
    if (value === '' || value === undefined || value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeScale(value, source) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return clone(value);
    const scaleId = valueOrNull(value) ??
      valueOrNull(source?.scale_id) ??
      valueOrNull(source?.scale_type);
    const scale = {
      id: scaleId,
      psychometric_level: valueOrNull(source?.psychometric_level),
      min: numericOrNull(source?.scale_min ?? source?.min),
      max: numericOrNull(source?.scale_max ?? source?.max),
      step: numericOrNull(source?.scale_step ?? source?.step),
      unit: valueOrNull(source?.scale_unit || source?.unit),
      direction: valueOrNull(source?.scale_direction || source?.direction)
    };
    return Object.values(scale).some(item => item !== null) ? scale : null;
  }

  function normalizedWords(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function numericSequence(options) {
    if (!Array.isArray(options) || options.length < 2) return null;
    const values = options.map(option => numericOrNull(option?.value));
    if (values.some(value => value === null)) return null;
    const step = values[1] - values[0];
    if (!(step > 0) || values.some((value, index) => index > 0 && value - values[index - 1] !== step)) {
      return null;
    }
    return { min: values[0], max: values.at(-1), step };
  }

  function includesAny(value, candidates) {
    const words = normalizedWords(value);
    return candidates.some(candidate => words.includes(candidate));
  }

  function inferQuestionContract(question) {
    const result = clone(question || {});
    result.type = normalizeResponseType(result.type);
    result.options = normalizeOptions(result.options);
    const labels = result.options.map(option => normalizedWords(option.text));
    const prompt = normalizedWords(result.prompt);
    const joined = labels.join(' ');
    const sequence = numericSequence(result.options);
    const hasOptions = result.options.length >= 2;
    const multipleInstruction = includesAny(prompt, [
      'select all', 'choose all', 'multiple answers', 'mark all',
      'seleccione todas', 'elija todas', 'respuestas multiples',
      'выберите все', 'несколько вариантов', 'множественный выбор'
    ]);

    if (!result.type && hasOptions) {
      result.type = multipleInstruction ? 'multiple_select' : 'single_select';
    }

    if (!result.scale && result.type === 'text_input') {
      result.scale = {
        id: 'text', psychometric_level: 'textual', min: null, max: null,
        step: null, unit: null, direction: null
      };
    } else if (!result.scale && result.type === 'numeric_input') {
      result.scale = {
        id: 'numeric', psychometric_level: 'interval_ratio', min: null, max: null,
        step: null, unit: null, direction: null
      };
    } else if (!result.scale && hasOptions) {
      const yesNo = labels.length === 2 &&
        includesAny(joined, ['yes', 'si', 'да']) &&
        includesAny(joined, ['no', 'нет']);
      const frequency = labels.length >= 3 &&
        includesAny(joined, ['never', 'nunca', 'никогда']) &&
        includesAny(joined, ['always', 'siempre', 'всегда']);
      const agreement = labels.length >= 3 &&
        includesAny(joined, ['disagree', 'desacuerdo', 'не соглас']) &&
        includesAny(joined, ['agree', 'acuerdo', 'соглас']);
      const explicitNps = includesAny(prompt, ['nps', 'net promoter']) &&
        sequence?.min === 0 && sequence?.max === 10;

      if (yesNo) {
        result.scale = {
          id: 'dichotomous',
          psychometric_level: 'nominal',
          min: sequence?.min ?? null,
          max: sequence?.max ?? null,
          step: sequence?.step ?? null,
          unit: null,
          direction: null
        };
      } else if (frequency) {
        result.scale = {
          id: 'frequency_scale',
          psychometric_level: 'ordinal',
          min: sequence?.min,
          max: sequence?.max,
          step: sequence?.step,
          unit: null,
          direction: null
        };
      } else if (agreement && [5, 7].includes(result.options.length)) {
        result.scale = {
          id: `likert_${result.options.length}`,
          psychometric_level: 'ordinal',
          min: sequence?.min ?? 1,
          max: sequence?.max ?? result.options.length,
          step: sequence?.step ?? 1,
          unit: null,
          direction: null
        };
      } else if (explicitNps) {
        result.scale = {
          id: 'nps_scale',
          psychometric_level: 'ordinal',
          min: 0,
          max: 10,
          step: 1,
          unit: null,
          direction: null
        };
      } else if (sequence && result.options.every(option => {
        const numericText = numericOrNull(String(option.text || '').replace(',', '.'));
        return numericText !== null && numericText === numericOrNull(option.value);
      })) {
        result.scale = {
          id: `ordinal_${sequence.min}_${sequence.max}`,
          psychometric_level: 'ordinal',
          min: sequence.min,
          max: sequence.max,
          step: sequence.step,
          unit: null,
          direction: null
        };
      } else {
        result.scale = {
          id: multipleInstruction ? 'multiple_choice' : 'single_choice',
          psychometric_level: 'nominal',
          min: null,
          max: null,
          step: null,
          unit: null,
          direction: null
        };
      }
    }
    if (result.scale && typeof result.scale === 'object' && !result.scale.psychometric_level) {
      const scaleId = normalizedWords(result.scale.id);
      if (result.type === 'text_input') {
        result.scale.psychometric_level = 'textual';
      } else if (result.type === 'numeric_input') {
        result.scale.psychometric_level = 'interval_ratio';
      } else if (/(?:likert|frequency|ordinal|nps)/.test(scaleId)) {
        result.scale.psychometric_level = 'ordinal';
      } else if (['single_select', 'multiple_select'].includes(result.type) && hasOptions) {
        result.scale.psychometric_level = 'nominal';
      }
    }
    return result;
  }

  function mayFallbackToPlainText(sourceFormat) {
    return new Set(['text', 'txt']).has(String(sourceFormat || '').toLowerCase());
  }

  function decodeTextBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = new Uint8Array(bytes.length - 2);
      for (let index = 2; index + 1 < bytes.length; index += 2) {
        swapped[index - 2] = bytes[index + 1];
        swapped[index - 1] = bytes[index];
      }
      return new TextDecoder('utf-16le').decode(swapped);
    }
    const withoutBom = bytes.length >= 3 &&
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(withoutBom);
    } catch (_) {
      return new TextDecoder('windows-1252').decode(withoutBom);
    }
  }

  function pdfItemsToText(items) {
    const positioned = (Array.isArray(items) ? items : [])
      .filter(item => item && String(item.str || '').trim())
      .map((item, index) => ({
        index,
        text: String(item.str),
        x: Number(item.transform?.[4]) || 0,
        y: Number(item.transform?.[5]) || 0,
        width: Math.max(0, Number(item.width) || 0),
        height: Math.max(
          1,
          Math.abs(Number(item.height) || 0),
          Math.abs(Number(item.transform?.[3]) || 0)
        )
      }));
    if (!positioned.length) return '';

    const heights = positioned.map(item => item.height).sort((left, right) => left - right);
    const typicalHeight = heights[Math.floor(heights.length / 2)];
    const yTolerance = Math.max(1.5, typicalHeight * 0.35);
    const rows = [];

    positioned
      .sort((left, right) => right.y - left.y || left.x - right.x || left.index - right.index)
      .forEach(item => {
        let row = rows.find(candidate => Math.abs(candidate.y - item.y) <= yTolerance);
        if (!row) {
          row = { y: item.y, items: [] };
          rows.push(row);
        }
        row.items.push(item);
        row.y = row.items.reduce((sum, entry) => sum + entry.y, 0) / row.items.length;
      });

    return rows
      .sort((left, right) => right.y - left.y)
      .map(row => {
        const rowItems = row.items.sort((left, right) => left.x - right.x || left.index - right.index);
        let text = '';
        let previousEnd = null;
        rowItems.forEach(item => {
          if (text) {
            const gap = previousEnd === null ? 0 : item.x - previousEnd;
            const needsSpace = gap > Math.max(0.8, item.height * 0.08) &&
              !/^[,.;:!?%)\]}]/.test(item.text) &&
              !/[(\[{¿¡]$/.test(text);
            if (needsSpace) text += ' ';
          }
          text += item.text;
          previousEnd = Math.max(previousEnd ?? item.x, item.x + item.width);
        });
        return text.trim();
      })
      .filter(Boolean)
      .join('\n');
  }

  function questionFromTabularRows(rows, index) {
    const first = rows[0];
    const qCode = code(first.code || first.question_code || `Q_${index + 1}`, `Q_${index + 1}`);
    const options = rows
      .filter(row => valueOrNull(row.option_text) !== null || valueOrNull(row.option_value) !== null)
      .map((row, optionIndex) => ({
        value: valueOrNull(row.option_value) ?? optionIndex + 1,
        text: String(valueOrNull(row.option_text) ?? '')
      }));
    const explicitOptions = options.length ? options : normalizeOptions(first.options || first.choices);
    return inferQuestionContract({
      question_id: UUID_V4.test(String(first.question_id || '')) ? first.question_id : uuid(),
      code: qCode,
      version: Math.max(1, Number(first.version || first.question_version) || 1),
      block: valueOrNull(first.block),
      family: valueOrNull(first.family),
      domain: valueOrNull(first.domain),
      parameter: valueOrNull(first.parameter),
      type: valueOrNull(first.type || first.response_type || first.question_type),
      prompt: String(first.prompt || first.question_prompt || first.question || first.text || '').trim(),
      options: explicitOptions,
      scale: normalizeScale(first.scale_contract || first.scale, first),
      score_direction: valueOrNull(first.score_direction),
      time: {
        tracking_mode: valueOrNull(first.tracking_mode),
        wave: valueOrNull(first.wave),
        lag: valueOrNull(first.lag)
      },
      status: STATUS.has(first.status) ? first.status : 'draft'
    });
  }

  function rowsToQuestionBank(rows, metadata) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('The spreadsheet contains no data rows.');
    const normalizedRows = rows.filter(row => row && typeof row === 'object');
    if (!normalizedRows.length) throw new Error('The imported list contains no structured question rows.');
    const grouped = new Map();
    normalizedRows.forEach((row, index) => {
      const stableQuestionId = UUID_V4.test(String(row.question_id || '')) ? row.question_id : '';
      const sourceSheet = String(row.__source_sheet || '');
      const sourceCode = String(row.code || row.question_code || `ROW_${index + 1}`);
      const key = stableQuestionId || `${sourceSheet}::${sourceCode}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const questions = {};
    Array.from(grouped.values()).forEach((questionRows, index) => {
      const question = questionFromTabularRows(questionRows, index);
      let uniqueCode = question.code;
      let suffix = 2;
      while (questions[uniqueCode]) uniqueCode = `${question.code}_${suffix++}`;
      if (uniqueCode !== question.code) {
        question.source_code = question.code;
        question.normalized_code_collision = true;
      }
      question.code = uniqueCode;
      question.source_sheet = valueOrNull(questionRows[0].__source_sheet);
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

  function numericRangeOptions(line) {
    const compact = String(line || '').trim();
    let match = compact.match(/^(?:scale|escala|шкала)?\s*:?\s*(-?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|до|a)\s*(-?\d+(?:[.,]\d+)?)\s*$/i);
    if (!match) {
      const values = compact.split(/\s+/).map(value => numericOrNull(value.replace(',', '.')));
      if (values.length >= 3 && values.length <= 21 && values.every(value => value !== null)) {
        const step = values[1] - values[0];
        if (step > 0 && values.every((value, index) => index === 0 || value - values[index - 1] === step)) {
          return values.map(value => ({ value, text: String(value) }));
        }
      }
      return null;
    }
    const min = numericOrNull(match[1].replace(',', '.'));
    const max = numericOrNull(match[2].replace(',', '.'));
    if (
      min === null || max === null ||
      !Number.isInteger(min) || !Number.isInteger(max) ||
      max < min || max - min > 20
    ) return null;
    return Array.from({ length: max - min + 1 }, (_, index) => {
      const value = min + index;
      return { value, text: String(value) };
    });
  }

  function optionFromLine(line) {
    const value = String(line || '').trim();
    const bullet = value.match(/^[-*•]\s+(.+)$/);
    if (bullet) return { value: null, text: bullet[1].trim() };
    const letter = value.match(/^([A-Za-zА-Яа-я])\s*[\.)]\s+(.+)$/);
    if (letter) return { value: letter[1], text: letter[2].trim() };
    const numeric = value.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:[\.)]|[-–—:])\s+(.+)$/);
    if (numeric) {
      return {
        value: numericOrNull(numeric[1].replace(',', '.')),
        text: numeric[2].trim()
      };
    }
    return null;
  }

  function extractPlainTextQuestions(text) {
    const clean = String(text || '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      .replace(/\r/g, '');
    const lines = clean.split('\n');
    const candidates = [];
    let current = null;
    let awaitingQuestion = false;
    let collectingQuestion = false;
    let collectingExplanation = false;
    let collectingVariables = false;
    let collectingOptions = false;
    let blankBefore = true;
    let pendingDomain = null;
    const questionHeading = /^(?:глубинный\s+)?(?:исследовательский\s+)?вопрос\s*:|^(?:deep\s+)?research\s+question\s*:|^pregunta\s+(?:de\s+)?investigaci[oó]n\s*:/i;
    const explanationHeading = /^(?:пояснение|explanation|explicaci[oó]n)\s*:/i;
    const variablesHeading = /^(?:переменные|variables|variables del modelo)\s*:/i;
    const optionsHeading = /^(?:варианты(?:\s+ответов)?|answers?|options?|opciones(?:\s+de\s+respuesta)?)\s*:/i;
    const domainHeading = /^([A-ZА-Я])\s*[-–—]\s+(.+)$/;
    const numberedLine = /^(?:q(?:uestion)?\s*)?(\d+)\s*([\.)])\s+(.+)$/i;

    function startQuestion(prompt, sourceNumber) {
      current = {
        prompt: String(prompt || '').trim(),
        options: [],
        source_question_number: sourceNumber || null,
        explanation: null,
        domain: pendingDomain ? clone(pendingDomain) : null,
        source_variables: []
      };
      candidates.push(current);
      collectingQuestion = !/[?？]\s*$/.test(current.prompt);
      collectingExplanation = false;
      collectingVariables = false;
      collectingOptions = false;
      awaitingQuestion = false;
    }

    function storeVariables(candidate, variableText) {
      const cleanVariables = String(variableText || '').trim();
      candidate.source_variables = Array.from(
        cleanVariables.matchAll(/\b([A-Za-zА-Яа-я]\d+)\b/g),
        match => match[1]
      );
      candidate.source_variables_text = cleanVariables || null;
    }

    function appendExplanation(candidate, textValue) {
      const value = String(textValue || '').trim();
      const variablesIndex = value.search(/(?:переменные|variables del modelo|variables)\s*:/i);
      const explanationPart = variablesIndex >= 0 ? value.slice(0, variablesIndex).trim() : value;
      const variablesPart = variablesIndex >= 0
        ? value.slice(variablesIndex).replace(variablesHeading, '').trim()
        : '';
      candidate.explanation = `${candidate.explanation || ''} ${explanationPart}`
        .replace(/\s+/g, ' ')
        .trim();
      if (variablesIndex >= 0) {
        storeVariables(candidate, variablesPart);
        collectingExplanation = false;
        collectingVariables = true;
      }
    }

    lines.forEach(rawLine => {
      const line = rawLine.trim();
      if (!line) {
        blankBefore = true;
        return;
      }
      const domain = line.match(domainHeading);
      if (domain) {
        pendingDomain = { code: domain[1], title: domain[2].trim() };
        collectingQuestion = false;
        collectingExplanation = false;
        collectingVariables = false;
        collectingOptions = false;
        awaitingQuestion = false;
        blankBefore = false;
        return;
      }
      if (questionHeading.test(line)) {
        const inline = line.replace(questionHeading, '').trim();
        if (inline) startQuestion(inline, null);
        else {
          awaitingQuestion = true;
          collectingQuestion = false;
          collectingExplanation = false;
          collectingVariables = false;
          collectingOptions = false;
        }
        blankBefore = false;
        return;
      }
      if (optionsHeading.test(line)) {
        if (current) {
          const inlineOptions = line.replace(optionsHeading, '').trim();
          if (inlineOptions) {
            inlineOptions
              .split(/\s*(?:\||;)\s*/)
              .filter(Boolean)
              .forEach(textValue => {
                current.options.push({
                  value: current.options.length + 1,
                  text: textValue
                });
              });
          }
          collectingQuestion = false;
          collectingExplanation = false;
          collectingVariables = false;
          collectingOptions = true;
        }
        blankBefore = false;
        return;
      }
      if (variablesHeading.test(line)) {
        if (current) {
          const variableText = line.replace(variablesHeading, '').trim();
          storeVariables(current, variableText);
          collectingExplanation = false;
          collectingQuestion = false;
          collectingVariables = true;
        }
        blankBefore = false;
        return;
      }
      if (explanationHeading.test(line)) {
        const inline = line.replace(explanationHeading, '').trim();
        if (current) {
          current.explanation = '';
          appendExplanation(current, inline);
          if (!collectingVariables) collectingExplanation = true;
        }
        awaitingQuestion = true;
        collectingQuestion = false;
        awaitingQuestion = false;
        blankBefore = false;
        return;
      }
      if (awaitingQuestion) {
        const numbered = line.match(numberedLine);
        startQuestion(numbered ? numbered[3] : line, numbered?.[1] || null);
        blankBefore = false;
        return;
      }

      const numbered = line.match(numberedLine);
      const option = current ? optionFromLine(line) : null;
      const rangeOptions = current ? numericRangeOptions(line) : null;
      const mustStartQuestion = numbered && (
        !current ||
        /[?？]\s*$/.test(numbered[3]) ||
        (blankBefore && current.options.length >= 2) ||
        (numbered[2] === '.' && current.options.length === 0 &&
          Number(numbered[1]) === Number(current.source_question_number || 0) + 1)
      );

      if (mustStartQuestion) {
        startQuestion(numbered[3], numbered[1]);
      } else if (current && rangeOptions) {
        current.options.push(...rangeOptions);
        collectingQuestion = false;
        collectingExplanation = false;
      } else if (current && option && !collectingExplanation) {
        const optionValue = option.value === null ? current.options.length + 1 : option.value;
        current.options.push({ value: optionValue, text: option.text });
        collectingQuestion = false;
        collectingVariables = false;
        collectingOptions = true;
      } else if (current && collectingOptions) {
        current.options.push({
          value: current.options.length + 1,
          text: line
        });
      } else if (current && collectingVariables) {
        storeVariables(
          current,
          `${current.source_variables_text || ''} ${line}`.replace(/\s+/g, ' ').trim()
        );
      } else if (current && collectingExplanation) {
        appendExplanation(current, line);
      } else if (current && collectingQuestion) {
        current.prompt = `${current.prompt} ${line}`.replace(/\s+/g, ' ').trim();
        collectingQuestion = !/[?？]\s*$/.test(line);
      } else if (/[?？]\s*$/.test(line)) {
        startQuestion(line, null);
      }
      blankBefore = false;
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
      questions[qCode] = inferQuestionContract({
        question_id: uuid(),
        code: qCode,
        version: 1,
        block: null,
        family: null,
        domain: candidate.domain?.code || null,
        parameter: null,
        type: null,
        prompt: candidate.prompt,
        options: candidate.options,
        scale: null,
        score_direction: null,
        time: {
          tracking_mode: null,
          wave: null,
          lag: null
        },
        status: 'draft',
        source_context: {
          question_number: candidate.source_question_number,
          explanation: valueOrNull(candidate.explanation),
          domain_title: valueOrNull(candidate.domain?.title),
          variables: candidate.source_variables,
          variables_text: valueOrNull(candidate.source_variables_text)
        }
      });
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
      const baseCode = code(raw.code || key, `Q_${index + 1}`);
      let qCode = baseCode;
      let suffix = 2;
      while (questions[qCode]) qCode = `${baseCode}_${suffix++}`;
      const source = clone(raw);
      const importedRouting = source.routing && typeof source.routing === 'object'
        ? clone(source.routing)
        : null;
      delete source.routing;
      const question = inferQuestionContract({
        ...source,
        question_id: UUID_V4.test(String(raw.question_id || '')) ? raw.question_id : uuid(),
        code: qCode,
        version: Math.max(1, Number(raw.version) || 1),
        block: valueOrNull(raw.block),
        family: valueOrNull(raw.family),
        domain: valueOrNull(raw.domain),
        parameter: valueOrNull(raw.parameter),
        type: valueOrNull(raw.type || raw.response_type || raw.question_type),
        prompt: String(raw.prompt || raw.question_prompt || raw.question || raw.text || '').trim(),
        options: normalizeOptions(raw.options || raw.answer_options || raw.choices),
        scale: normalizeScale(raw.scale_contract || raw.scale, raw),
        score_direction: valueOrNull(raw.score_direction),
        time: raw.time && typeof raw.time === 'object'
          ? clone(raw.time)
          : { tracking_mode: null, wave: null, lag: null },
        status: STATUS.has(raw.status) ? raw.status : 'draft'
      });
      if (importedRouting) {
        question.source_context = {
          ...(question.source_context && typeof question.source_context === 'object'
            ? question.source_context
            : {}),
          imported_routing: importedRouting
        };
      }
      if (qCode !== baseCode) {
        question.source_code = baseCode;
        question.normalized_code_collision = true;
      }
      questions[qCode] = question;
    });
    if (!Object.keys(questions).length) throw new Error('The imported structure contains no question definitions.');
    return questions;
  }

  function responseTypeFromPsychometrics(properties) {
    const codingSchema = Array.isArray(properties?.coding_schema) ? properties.coding_schema : [];
    if (codingSchema.length) return 'single_select';
    if (properties?.bounds && typeof properties.bounds === 'object') return 'numeric_input';
    return null;
  }

  function strictCyanProtocolToQuestionBank(input, metadata) {
    if (!Array.isArray(input?.variables) || !input.variables.length) {
      throw new Error('The Strict Cyan Protocol contains no variables.');
    }
    const questions = {};
    input.variables.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const properties = raw.psychometric_properties &&
        typeof raw.psychometric_properties === 'object' &&
        !Array.isArray(raw.psychometric_properties)
        ? raw.psychometric_properties
        : {};
      const bounds = properties.bounds &&
        typeof properties.bounds === 'object' &&
        !Array.isArray(properties.bounds)
        ? properties.bounds
        : null;
      const codingSchema = Array.isArray(properties.coding_schema)
        ? properties.coding_schema
        : [];
      const baseCode = code(raw.code || raw.variable_id, `Q_${index + 1}`);
      let qCode = baseCode;
      let suffix = 2;
      while (questions[qCode]) qCode = `${baseCode}_${suffix++}`;
      const question = inferQuestionContract({
        question_id: UUID_V4.test(String(raw.question_id || '')) ? raw.question_id : uuid(),
        code: qCode,
        version: Math.max(1, Number(raw.version) || 1),
        block: valueOrNull(raw.block),
        family: valueOrNull(raw.family),
        domain: valueOrNull(raw.domain),
        parameter: valueOrNull(raw.parameter),
        source_variable_id: valueOrNull(raw.variable_id),
        type: valueOrNull(raw.type || raw.response_type) || responseTypeFromPsychometrics(properties),
        prompt: String(raw.prompt || raw.question_prompt || '').trim(),
        options: codingSchema.map((item, optionIndex) => ({
          value: item && Object.prototype.hasOwnProperty.call(item, 'code_or_weight')
            ? item.code_or_weight
            : optionIndex,
          text: String(item?.label ?? ''),
          target_transition: valueOrNull(item?.target_transition)
        })),
        scale: {
          id: valueOrNull(properties.scale_subtype),
          psychometric_level: valueOrNull(properties.measurement_level),
          min: numericOrNull(bounds?.min),
          max: numericOrNull(bounds?.max),
          step: numericOrNull(bounds?.step),
          unit: valueOrNull(bounds?.unit),
          direction: valueOrNull(properties.direction)
        },
        score_direction: valueOrNull(raw.score_direction || properties.direction),
        time: {
          tracking_mode: valueOrNull(properties.tracking_mode),
          wave: valueOrNull(properties.wave),
          lag: valueOrNull(properties.time_lag)
        },
        inversion_metadata: properties.inversion_metadata &&
          typeof properties.inversion_metadata === 'object'
          ? clone(properties.inversion_metadata)
          : null,
        text_constraints: properties.text_constraints &&
          typeof properties.text_constraints === 'object'
          ? clone(properties.text_constraints)
          : valueOrNull(properties.text_constraints),
        status: STATUS.has(raw.status) ? raw.status : 'draft'
      });
      if (raw.routing && typeof raw.routing === 'object') {
        question.source_context = {
          ...(question.source_context && typeof question.source_context === 'object'
            ? question.source_context
            : {}),
          imported_routing: clone(raw.routing)
        };
      }
      questions[qCode] = question;
    });
    if (!Object.keys(questions).length) {
      throw new Error('The Strict Cyan Protocol contains no usable variable definitions.');
    }
    const bank = newQuestionBank(questions, {
      ...metadata,
      title: input.title || input.engine || metadata?.title,
      code: input.code || input.engine || metadata?.code,
      version: input.bank_version,
      primary_language: input.language || metadata?.primary_language,
      global_mode: input.global_mode,
      global_time_reference: input.global_time_reference || input.timestamp
    });
    bank.source_contract = {
      schema: 'research_os.strict_cyan_protocol',
      engine: valueOrNull(input.engine),
      version: valueOrNull(input.version),
      psychometric_integrity: valueOrNull(input.psychometric_integrity),
      timestamp: valueOrNull(input.timestamp)
    };
    return bank;
  }

  function newQuestionBank(questions, metadata) {
    const now = new Date().toISOString();
    const title = String(metadata?.title || '').trim();
    const bankId = UUID_V4.test(String(metadata?.bank_id || '')) ? metadata.bank_id : uuid();
    const explicitCode = code(metadata?.code, '');
    const titleCode = code(title, '');
    const generatedCode = `${titleCode || 'BANK'}_${bankId.slice(0, 8).toUpperCase()}`;
    return {
      schema: 'research_os.question_bank',
      schema_version: 2,
      bank_id: bankId,
      code: explicitCode || generatedCode,
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
    if (Array.isArray(value?.variables) && value?.engine) {
      return strictCyanProtocolToQuestionBank(value, metadata);
    }
    if (Array.isArray(value)) {
      if (value.every(item => typeof item === 'string')) {
        const questions = {};
        value.forEach((prompt, index) => {
          const qCode = `Q_${index + 1}`;
          questions[qCode] = inferQuestionContract({
            question_id: uuid(), code: qCode, version: 1, block: null, family: null,
            domain: null, parameter: null, type: null, prompt: String(prompt).trim(),
            options: [], scale: null, score_direction: null,
            time: { tracking_mode: null, wave: null, lag: null }, status: 'draft'
          });
        });
        return newQuestionBank(questions, metadata);
      }
      return rowsToQuestionBank(value, metadata);
    }
    const isSingleQuestion = value && typeof value === 'object' && !Array.isArray(value) &&
      ['prompt', 'question_prompt', 'question', 'text'].some(key =>
        Object.prototype.hasOwnProperty.call(value, key)
      );
    const questionSource = isSingleQuestion
      ? { [String(value.code || 'Q_1')]: value }
      : value;
    return newQuestionBank(normalizeQuestionMap(questionSource), {
      ...metadata,
      title: isSingleQuestion ? metadata?.title : value?.title || metadata?.title,
      code: isSingleQuestion ? metadata?.code : value?.code || metadata?.code,
      bank_id: isSingleQuestion ? metadata?.bank_id : value?.bank_id,
      version: isSingleQuestion ? metadata?.version : value?.version,
      status: isSingleQuestion ? metadata?.status : value?.status,
      primary_language: isSingleQuestion
        ? metadata?.primary_language
        : value?.primary_language || metadata?.primary_language,
      interface_language: isSingleQuestion
        ? metadata?.interface_language
        : value?.interface_language || metadata?.interface_language,
      global_mode: isSingleQuestion ? metadata?.global_mode : value?.global_mode,
      global_time_reference: isSingleQuestion
        ? metadata?.global_time_reference
        : value?.global_time_reference
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
    if (!String(bank.primary_language || '').trim()) issue('error', 'MISSING_PRIMARY_LANGUAGE', 'The primary content language is required.');
    if (!bank.global_time_reference || Number.isNaN(Date.parse(bank.global_time_reference))) {
      issue('error', 'INVALID_GLOBAL_TIME_REFERENCE', 'A valid Global Time Reference timestamp is required.');
    }
    if (!Array.isArray(bank.question_order) || !bank.questions || typeof bank.questions !== 'object') {
      issue('error', 'INVALID_QUESTION_COLLECTION', 'questions and question_order are required.');
      return diagnostics;
    }
    if (bank.question_order.length === 0 || Object.keys(bank.questions).length === 0) {
      issue('error', 'EMPTY_QUESTION_BANK', 'The question bank must contain at least one question.');
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
      if (/^(?:new research question|nueva pregunta de investigaci[oó]n|новый вопрос исследования)\s*\?$/i.test(String(question.prompt || '').trim())) {
        issue('error', 'PLACEHOLDER_PROMPT', 'The question still contains an unfinished placeholder prompt.', questionCode);
      }
      if (!question.type) issue('error', 'UNRESOLVED_TYPE', 'Response type must be selected before this question can be registered.', questionCode);
      if (question.type && !['single_select', 'multiple_select', 'numeric_input', 'text_input'].includes(question.type)) {
        issue('error', 'INVALID_TYPE', 'The response type is not supported by the questionnaire runtime.', questionCode);
      }
      const scaleResolved = question.scale && typeof question.scale === 'object' &&
        String(question.scale.id || '').trim();
      if (!scaleResolved) issue('error', 'UNRESOLVED_SCALE', 'A scale contract must be selected before this question can be registered.', questionCode);
      if (scaleResolved && !String(question.scale.psychometric_level || '').trim()) {
        issue('error', 'UNRESOLVED_PSYCHOMETRIC_LEVEL', 'The psychometric level must be selected before this question can be registered.', questionCode);
      }
      if (scaleResolved && !['nominal', 'ordinal', 'interval_ratio', 'textual'].includes(question.scale.psychometric_level)) {
        issue('error', 'INVALID_PSYCHOMETRIC_LEVEL', 'The psychometric level is not supported by the analysis contract.', questionCode);
      }
      if (!Array.isArray(question.options)) issue('error', 'INVALID_OPTIONS', 'Question options must be an array.', questionCode);
      if (['single_select', 'multiple_select'].includes(question.type) && (!Array.isArray(question.options) || question.options.length < 2)) {
        issue('error', 'MISSING_OPTIONS', 'A selection question needs at least two answer options.', questionCode);
      }
      if (Array.isArray(question.options)) {
        const optionValues = new Set();
        question.options.forEach((option, optionIndex) => {
          if (!option || typeof option !== 'object' || !String(option.text || '').trim()) {
            issue('error', 'INVALID_OPTION', `Option ${optionIndex + 1} needs text.`, questionCode);
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(option, 'value') || option.value === null || option.value === undefined) {
            issue('error', 'MISSING_OPTION_VALUE', `Option ${optionIndex + 1} needs a stable value.`, questionCode);
          }
          const optionKey = JSON.stringify(option.value);
          if (optionValues.has(optionKey)) issue('error', 'DUPLICATE_OPTION_VALUE', 'Answer option values must be unique.', questionCode);
          optionValues.add(optionKey);
          if (Object.prototype.hasOwnProperty.call(option, 'next') || Object.prototype.hasOwnProperty.call(option, 'target')) {
            issue('error', 'QUESTION_ROUTING', 'Questionnaire routing must be configured in the questionnaire constructor.', questionCode);
          }
        });
      }
      if (Object.prototype.hasOwnProperty.call(question, 'routing')) {
        issue('error', 'QUESTION_ROUTING', 'Questionnaire routing must be configured in the questionnaire constructor.', questionCode);
      }
      if (question.normalized_code_collision) {
        issue('warning', 'NORMALIZED_CODE_COLLISION', `Imported code ${question.source_code} was made unique as ${questionCode}.`, questionCode);
      }
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
    mayFallbackToPlainText,
    decodeTextBytes,
    pdfItemsToText,
    rowsToQuestionBank,
    extractPlainTextQuestions,
    plainTextToQuestionBank,
    inferQuestionContract,
    canonicalOrConverted,
    strictCyanProtocolToQuestionBank,
    validateQuestionBank,
    summarize
  });
})(typeof window !== 'undefined' ? window : globalThis);
