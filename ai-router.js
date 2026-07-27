/**
 * AI Router Module
 * Централизованный менеджер вызовов API
 */

const AIRouter = {
    getTaskConfig(taskName) {
        const settings = JSON.parse(localStorage.getItem('ai_router_config') || '{}');
        return settings[taskName] || { provider: 'groq', model: 'llama-3.3-70b-versatile' };
    },

    getApiKey(provider) {
        const keys = JSON.parse(localStorage.getItem('ai_api_keys') || '{}');
        return keys[provider] || '';
    },

    async sendRequest(taskName, systemPrompt, payload) {
        const config = this.getTaskConfig(taskName);
        const apiKey = this.getApiKey(config.provider);

        if (!apiKey) {
            throw new Error(`Не найден API-ключ для сервиса: ${config.provider.toUpperCase()}. Введите его на странице settings.html`);
        }

        const userContent = typeof payload === 'object' ? JSON.stringify(payload) : payload;

        switch (config.provider) {
            case 'groq':
            case 'openai':
            case 'deepseek':
                return await this.callOpenAICompatibleAPI(config, apiKey, systemPrompt, userContent);
            case 'gemini':
                return await this.callGeminiAPI(config, apiKey, systemPrompt, userContent);
            default:
                throw new Error(`Неподдерживаемый сервис: ${config.provider}`);
        }
    },

    async callOpenAICompatibleAPI(config, apiKey, systemPrompt, userContent) {
        let endpoint = 'https://api.openai.com/v1/chat/completions';
        if (config.provider === 'groq') endpoint = 'https://api.groq.com/openai/v1/chat/completions';
        if (config.provider === 'deepseek') endpoint = 'https://api.deepseek.com/chat/completions';

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                temperature: 0.1,
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message || 'Ошибка API');
        return JSON.parse(data.choices[0].message.content);
    },

    async callGeminiAPI(config, apiKey, systemPrompt, userContent) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
        const fullPrompt = `${systemPrompt}\n\nДанные в JSON:\n${userContent}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: fullPrompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message || 'Ошибка Gemini API');

        const rawText = data.candidates[0].content.parts[0].text;
        return JSON.parse(rawText);
    }
};
