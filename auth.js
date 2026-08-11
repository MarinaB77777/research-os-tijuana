(function (global) {
  'use strict';

  const STORAGE_KEY = 'research_os.auth.v1';
  const ALLOWED_ROLES = new Set(['researcher', 'respondent']);
  const AUTH_REQUEST_TIMEOUT_MS = 35000;

  function readSession() {
    try {
      const value = JSON.parse(global.sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (!value || !ALLOWED_ROLES.has(value.role) || !value.token || !value.user_identifier) {
        return null;
      }
      return value;
    } catch (_) {
      return null;
    }
  }

  function storeSession(value) {
    global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  function sessionFromPayload(payload) {
    return {
      token: payload.session_token,
      account_id: payload.account_id,
      role: payload.role,
      user_identifier: payload.user_identifier,
      expires_at: payload.expires_at || null,
      verified_at: new Date().toISOString()
    };
  }

  function clearSession() {
    global.sessionStorage.removeItem(STORAGE_KEY);
    global.sessionStorage.removeItem('research_os_researcher_token');
    global.localStorage.removeItem('os_active_session_token');
    global.localStorage.removeItem('researcher_token');
    global.localStorage.removeItem('ros_participant_session');
  }

  function safeReturnTarget(value, fallback) {
    const target = String(value || '');
    return /^[a-z0-9_-]+\.html(?:\?[a-z0-9_=&.%+-]*)?$/i.test(target)
      ? target
      : fallback;
  }

  async function parseResponse(response) {
    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    if (!response.ok) {
      const error = new Error(payload.error || payload.message || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = global.setTimeout(
      () => controller.abort(),
      timeoutMs || AUTH_REQUEST_TIMEOUT_MS
    );
    try {
      return await fetch(url, Object.assign({}, options || {}, {
        signal: controller.signal
      }));
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const timeoutError = new Error('Authentication request timed out');
        timeoutError.code = 'AUTH_REQUEST_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      global.clearTimeout(timer);
    }
  }

  async function login(username, password, expectedRole) {
    if (!username || !password) throw new Error('Username and password are required');
    if (expectedRole && !ALLOWED_ROLES.has(expectedRole)) throw new Error('Invalid expected role');
    const response = await fetchWithTimeout('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        expected_role: expectedRole || null
      })
    });
    const payload = await parseResponse(response);
    const session = sessionFromPayload(payload);
    storeSession(session);
    return session;
  }

  async function registerAccount(username, password, role) {
    if (!username || !password) throw new Error('Username and password are required');
    const requestedRole = role || 'respondent';
    if (!ALLOWED_ROLES.has(requestedRole)) throw new Error('Invalid registration role');
    const response = await fetchWithTimeout('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role: requestedRole })
    });
    const payload = await parseResponse(response);
    const session = sessionFromPayload(payload);
    storeSession(session);
    return session;
  }

  function registerRespondent(username, password) {
    return registerAccount(username, password, 'respondent');
  }

  async function verify(requiredRole) {
    const session = readSession();
    if (!session) return null;
    const response = await fetchWithTimeout('/api/auth/verify', {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store'
    });
    if (!response.ok) {
      clearSession();
      return null;
    }
    const payload = await parseResponse(response);
    if (requiredRole && payload.role !== requiredRole) return null;
    const refreshed = {
      token: session.token,
      account_id: payload.account_id,
      role: payload.role,
      user_identifier: payload.user_identifier,
      expires_at: payload.expires_at || null,
      verified_at: new Date().toISOString()
    };
    storeSession(refreshed);
    return refreshed;
  }

  function loginUrl(role, returnTarget) {
    const fallback = role === 'respondent' ? 'cabinet.html' : 'survey.html';
    const target = safeReturnTarget(returnTarget, fallback);
    return `login.html?role=${encodeURIComponent(role)}&return=${encodeURIComponent(target)}`;
  }

  async function requireRole(role, returnTarget) {
    try {
      const session = await verify(role);
      if (session) return session;
    } catch (_) {
      const target = loginUrl(role, returnTarget || global.location.pathname.split('/').pop());
      global.location.replace(`${target}&reason=auth_unavailable`);
      return null;
    }
    global.location.replace(loginUrl(role, returnTarget || global.location.pathname.split('/').pop()));
    return null;
  }

  function authHeaders(role, extra) {
    const session = readSession();
    if (!session || (role && session.role !== role)) return null;
    return Object.assign({}, extra || {}, { Authorization: `Bearer ${session.token}` });
  }

  async function logout(options) {
    const session = readSession();
    if (session && (!options || options.revoke !== false)) {
      try {
        await fetchWithTimeout('/api/auth/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` }
        });
      } catch (_) {
        // Local logout still completes if the network is unavailable.
      }
    }
    clearSession();
    global.location.assign((options && options.returnTo) || 'index.html');
  }

  async function createAccount(account, bootstrapSecret) {
    const headers = { 'Content-Type': 'application/json' };
    const authorized = authHeaders('researcher', headers);
    if (authorized) Object.assign(headers, authorized);
    if (bootstrapSecret) headers['X-Research-OS-Bootstrap-Secret'] = bootstrapSecret;
    const response = await fetchWithTimeout('/api/accounts', {
      method: 'POST',
      headers,
      body: JSON.stringify(account)
    });
    return parseResponse(response);
  }

  async function deleteAccount(password) {
    if (!password) throw new Error('Current password is required');
    const headers = authHeaders(null, { 'Content-Type': 'application/json' });
    if (!headers) throw new Error('An active account session is required');
    const response = await fetchWithTimeout('/api/account', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ password })
    });
    const payload = await parseResponse(response);
    clearSession();
    return payload;
  }

  global.ResearchAuth = Object.freeze({
    readSession,
    clearSession,
    safeReturnTarget,
    login,
    registerAccount,
    registerRespondent,
    verify,
    requireRole,
    loginUrl,
    authHeaders,
    createAccount,
    deleteAccount,
    logout
  });
})(window);
