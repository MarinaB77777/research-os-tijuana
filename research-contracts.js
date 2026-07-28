(function (global) {
  'use strict';

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ENTITY_STATUSES = Object.freeze(['draft', 'trial', 'active']);

  function createUuid() {
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

  function isUuid(value) {
    return UUID_V4.test(String(value || ''));
  }

  function normalizeCode(value, fallback) {
    const normalized = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return normalized || String(fallback || 'ENTITY');
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(global.localStorage.getItem(key) || 'null');
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    global.localStorage.setItem(key, JSON.stringify(value));
  }

  async function saveTextFile(name, mimeType, text, fallbackMessage) {
    if (typeof global.showSaveFilePicker === 'function') {
      try {
        const handle = await global.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: mimeType, accept: { [mimeType]: ['.' + name.split('.').pop()] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return { method: 'file-system-access' };
      } catch (error) {
        if (error && error.name === 'AbortError') return { method: 'cancelled' };
        throw error;
      }
    }
    if (fallbackMessage) global.alert(fallbackMessage);
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { method: 'download' };
  }

  function researcherToken() {
    try {
      const session = JSON.parse(global.sessionStorage.getItem('research_os.auth.v1') || 'null');
      return session && session.role === 'researcher' ? session.token : '';
    } catch (_) {
      return '';
    }
  }

  async function requestJson(url, options) {
    const requestOptions = Object.assign({}, options || {});
    const headers = new Headers(requestOptions.headers || {});
    const token = researcherToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    requestOptions.headers = headers;
    const response = await fetch(url, requestOptions);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    if (!response.ok) {
      throw new Error(payload.error || payload.message || `${response.status} ${response.statusText}`);
    }
    return payload;
  }

  function questionKey(bankId, bankVersion, questionId, questionVersion) {
    return [bankId, bankVersion, questionId, questionVersion].join(':');
  }

  function flattenQuestionBank(packageData) {
    if (!packageData || packageData.schema !== 'research_os.question_bank' ||
        packageData.schema_version !== 2 || !packageData.questions ||
        !Array.isArray(packageData.question_order)) {
      throw new Error('research_os.question_bank schema version 2 is required');
    }
    return packageData.question_order.map((code, index) => {
      const question = packageData.questions[code];
      if (!question || !isUuid(question.question_id) ||
          !Number.isInteger(question.version) || question.version < 1) {
        throw new Error(`Invalid question identity at position ${index + 1}`);
      }
      return {
        source_bank_id: packageData.bank_id,
        source_bank_version: packageData.version,
        source_bank_code: packageData.code,
        question_id: question.question_id,
        question_version: question.version,
        code: question.code,
        prompt: question.prompt,
        type: question.type,
        scale: question.scale,
        options: Array.isArray(question.options) ? question.options : [],
        domain: question.domain || null,
        parameter: question.parameter || null,
        status: question.status
      };
    });
  }

  global.ResearchContracts = Object.freeze({
    ENTITY_STATUSES,
    createUuid,
    isUuid,
    normalizeCode,
    nowIso,
    readJson,
    writeJson,
    saveTextFile,
    researcherToken,
    requestJson,
    questionKey,
    flattenQuestionBank
  });
})(window);
