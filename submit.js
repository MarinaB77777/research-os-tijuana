import { createClient } from '@supabase/supabase-js';

// Инициализация клиента базы данных (ключи берутся из переменных окружения Vercel)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
    // Разрешаем только POST-запросы
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { session_id, account_id, study_id, answers, consent_record } = req.body;

        // Записываем или обновляем данные сессии в Supabase
        const { data, error } = await supabase
            .from('research_sessions')
            .upsert([
                {
                    session_id,
                    account_id,
                    study_id,
                    answers,
                    consent_data: consent_record,
                    created_at: new Date().toISOString()
                }
            ], { onConflict: ['session_id'] });

        if (error) throw error;

        return res.status(200).json({ ok: true, message: 'Data successfully stored' });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
}
