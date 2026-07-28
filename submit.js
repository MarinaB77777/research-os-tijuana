import { createClient } from '@supabase/supabase-js';

// Инициализация клиента базы данных (ключи берутся из переменных окружения Vercel)
export default async function handler(req, res) {
    // Разрешаем только POST-запросы
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            return res.status(503).json({ ok: false, error: 'Server-side Supabase credentials are missing' });
        }
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { domain_data_identity: sourceIdentity, response_records: responseRecords } = req.body || {};
        if (!sourceIdentity || !Array.isArray(responseRecords) || responseRecords.length === 0) {
            return res.status(400).json({ ok: false, error: 'Source identity and response_records are required' });
        }

        const { data, error } = await supabase.rpc('save_response_records', {
            source_identity: sourceIdentity,
            response_records: responseRecords
        });

        if (error) throw error;

        return res.status(200).json({ ok: true, saved_count: responseRecords.length, database_result: data });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
}
