export default async function handler(req, res) {
    const { url, method } = req;
    
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    // 1. Генерация пользователя и его QR-токена
    if (url.includes('/tokens/generate') && method === 'POST') {
        const { type, customId } = req.body;
        
        if (!type || !['researcher', 'respondent'].includes(type)) {
            return res.status(400).json({ error: 'Invalid user type specified' });
        }

        const prefix = type === 'researcher' ? 'RES-' : 'RESP-';
        const userIdentifier = customId || (prefix + Math.floor(1000 + Math.random() * 9000));
        const qrToken = 'QR-' + crypto.randomUUID();

        if (supabaseUrl && supabaseKey) {
            try {
                await fetch(`${supabaseUrl}/rest/v1/app_users`, {
                    method: 'POST',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({
                        user_identifier: userIdentifier,
                        token: qrToken,
                        type: type
                    })
                });
            } catch (e) {
                console.error('Supabase write error:', e);
                return res.status(500).json({ error: e.message });
            }
        }

        return res.status(200).json({ 
            success: true, 
            token: qrToken, 
            userIdentifier: userIdentifier,
            type: type 
        });
    }

    // 2. Проверка токена при входе (сканирование QR-кода)
    if (url.includes('/verify') && method === 'GET') {
        const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const token = urlObj.searchParams.get('token');

        if (!token) {
            return res.status(400).json({ valid: false, error: 'Token missing' });
        }

        if (supabaseUrl && supabaseKey) {
            try {
                const response = await fetch(`${supabaseUrl}/rest/v1/app_users?token=eq.${encodeURIComponent(token)}&select=*`, {
                    method: 'GET',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`
                    }
                });
                const rows = await response.json();
                const data = rows && rows.length > 0 ? rows[0] : null;

                if (!data) {
                    return res.status(401).json({ valid: false, error: 'Token not found in database' });
                }

                return res.status(200).json({
                    valid: true,
                    type: data.type,
                    userIdentifier: data.user_identifier
                });
            } catch (e) {
                console.error('Supabase verification error:', e);
                return res.status(500).json({ valid: false, error: e.message });
            }
        }

        return res.status(500).json({ valid: false, error: 'Supabase credentials missing' });
    }

    // Создание аккаунта участника
    if (url.startsWith('/pilot/accounts') && method === 'POST') {
        const accountId = 'acc_' + Math.random().toString(36).substring(2, 10);
        return res.status(200).json({ ok: true, account_id: accountId });
    }

    // Загрузка списка доступных опросников
    if (url.startsWith('/pilot/questionnaire-banks')) {
        return res.status(200).json({
            ok: true,
            banks: [
                { id: 'psychometric_screening_v1', enabled: true, title_by_lang: { ru: 'Психометрический скрининг шкал', es: 'Evaluación psicométrica de escalas', en: 'Psychometric Scale Screening' } }
            ]
        });
    }

    // Получение текста информированного согласия
    if (url.startsWith('/consent/')) {
        return res.status(200).send(`<h3>Consentimiento Informado / Информированное согласие</h3><p>Pilot project in Tijuana, Mexico. Data will be stored securely for research purposes.</p>`);
    }

    // Старт сессии
    if (url.startsWith('/pilot/accounts/start-session') && method === 'POST') {
        const sessionId = 'ses_' + Math.random().toString(36).substring(2, 10);
        return res.status(200).json({ ok: true, session_id: sessionId });
    }

    // Загрузка вопросов опросника
    if (url.startsWith('/question-banks/')) {
        return res.status(200).json({
            ok: true,
            bank_id: 'psychometric_screening_v1',
            questions: [
                { code: 'KCog1', type: 'radio', prompt: 'Когда вы вспоминаете сложную задачу:', options: [{ value: 1, text: 'Нужно много времени' }, { value: 2, text: 'Решаю быстро' }] }
            ]
        });
    }

    // Сохранение ответов респондента в базу данных Supabase
    if (url.includes('/answers') && method === 'POST') {
        const { answers, domain_data_identity } = req.body;
        const sessionId = domain_data_identity?.session_id || 'unknown';

        if (supabaseUrl && supabaseKey) {
            try {
                await fetch(`${supabaseUrl}/rest/v1/research_sessions`, {
                    method: 'POST',
                    headers: {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates'
                    },
                    body: JSON.stringify({
                        session_id: sessionId,
                        answers: answers,
                        updated_at: new Date().toISOString()
                    })
                });
            } catch (e) {
                console.error('Supabase write error:', e);
            }
        }

        return res.status(200).json({ ok: true });
    }

    // Запуск сессии и генерация отчета
    if (url.includes('/run') || url.includes('/participant-report')) {
        return res.status(200).json({
            ok: true,
            participant_report: {
                title: 'Результат пилота',
                summary: 'Данные успешно зафиксированы.',
                resource_cards: [],
                limitations: ['Пилотная версия']
            }
        });
    }

    return res.status(404).json({ error: 'Endpoint not found', url });
}
