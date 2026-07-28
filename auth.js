(function (global) {
  'use strict';

  const STORAGE_KEY = 'research_os.auth.v1';
  const ALLOWED_ROLES = new Set(['researcher', 'respondent']);

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

  async function login(username, password, expectedRole) {
    if (!username || !password) throw new Error('Username and password are required');
    if (expectedRole && !ALLOWED_ROLES.has(expectedRole)) throw new Error('Invalid expected role');
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        expected_role: expectedRole || null
      })
    });
    const payload = await parseResponse(response);
    const session = {
      token: payload.session_token,
      account_id: payload.account_id,
      role: payload.role,
      user_identifier: payload.user_identifier,
      expires_at: payload.expires_at || null,
      verified_at: new Date().toISOString()
    };
    storeSession(session);
    return session;
  }

  async function verify(requiredRole) {
    const session = readSession();
    if (!session) return null;
    const response = await fetch('/api/auth/verify', {
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
    const session = await verify(role);
    if (session) return session;
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
        await fetch('/api/auth/revoke', {
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
    const response = await fetch('/api/accounts', {
      method: 'POST',
      headers,
      body: JSON.stringify(account)
    });
    return parseResponse(response);
  }

  global.ResearchAuth = Object.freeze({
    readSession,
    clearSession,
    safeReturnTarget,
    login,
    verify,
    requireRole,
    loginUrl,
    authHeaders,
    createAccount,
    logout
  });
})(window);
