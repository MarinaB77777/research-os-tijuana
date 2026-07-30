/**
 * AI Router Module
 * Browser client for the authenticated server-side AI gateway.
 * Provider credentials never enter browser storage or browser requests.
 */

localStorage.removeItem('ai_api_keys');
localStorage.removeItem('ai_router_config');

const AI_TASK_DEFAULTS = Object.freeze({
    analyzer: Object.freeze({ provider: 'groq', model: 'openai/gpt-oss-20b' }),
    translator: Object.freeze({ provider: 'groq', model: 'openai/gpt-oss-20b' })
});
const AI_TASK_MODELS = Object.freeze({
    analyzer: new Set([
        'groq:openai/gpt-oss-20b',
        'gemini:gemini-3.6-flash',
        'gemini:gemini-3.5-flash-lite'
    ]),
    translator: new Set([
        'groq:openai/gpt-oss-20b',
        'gemini:gemini-3.6-flash',
        'gemini:gemini-3.5-flash-lite'
    ])
});

const AIRouter = {
    preferences: {
        analyzer: AI_TASK_DEFAULTS.analyzer,
        translator: AI_TASK_DEFAULTS.translator
    },

    researcherSession() {
        try {
            const session = JSON.parse(sessionStorage.getItem('research_os.auth.v1') || 'null');
            return session?.role === 'researcher' && session?.token ? session : null;
        } catch (_) {
            return null;
        }
    },

    getTaskConfig(taskName) {
        const configured = this.preferences[taskName];
        const allowed = AI_TASK_MODELS[taskName];
        if (configured && allowed?.has(`${configured.provider}:${configured.model}`)) {
            return configured;
        }
        return AI_TASK_DEFAULTS[taskName] || AI_TASK_DEFAULTS.analyzer;
    },

    async loadPreferences() {
        const session = this.researcherSession();
        if (!session) return this.preferences;
        const response = await fetch('/api/ai/preferences', {
            headers: { 'Authorization': `Bearer ${session.token}` },
            cache: 'no-store'
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `${response.status} ${response.statusText}`);
        }
        this.preferences = data.preferences;
        return this.preferences;
    },

    async savePreferences(preferences) {
        const session = this.researcherSession();
        if (!session) {
            throw new Error('Researcher login is required to save AI preferences.');
        }
        const response = await fetch('/api/ai/preferences', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${session.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ preferences })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `${response.status} ${response.statusText}`);
        }
        this.preferences = data.preferences;
        return this.preferences;
    },

    async sendRequest(taskName, systemPrompt, payload) {
        const config = this.getTaskConfig(taskName);
        const session = this.researcherSession();
        if (!session || session.role !== 'researcher' || !session.token) {
            throw new Error('Researcher login is required for AI-assisted operations.');
        }

        const response = await fetch('/api/ai/request', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${session.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                task: taskName,
                provider: config.provider,
                model: config.model,
                system_prompt: systemPrompt,
                payload
            })
        });

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json')
            ? await response.json()
            : { error: await response.text() };
        if (!response.ok) {
            throw new Error(data.error || `${response.status} ${response.statusText}`);
        }
        return data.result;
    }
};
