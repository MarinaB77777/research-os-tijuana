-- 1. Банк вопросов (структура каждого пункта с измерительным контрактом)
CREATE TABLE question_bank (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,                     -- Текстовый код для удобства (например, GEN_HEALTH_01)
    schema_version TEXT NOT NULL DEFAULT 'questionnaire-components-1',
    title TEXT NOT NULL,                           -- Формулировка / промпт вопроса
    question_type TEXT NOT NULL,                   -- single_choice, numeric, duration и т.д.
    response_type TEXT NOT NULL,                   -- каноническая форма ответа
    scale_type TEXT,                               -- номинальная, порядковая, интервальная и т.д.
    presentation_type TEXT,                        -- радио, слайдер, инпут и т.д.
    validation JSONB DEFAULT '{}'::jsonb,          -- правила (required, min_value, max_value)
    options JSONB DEFAULT '[]'::jsonb,             -- массив вариантов для выбора (value, label)
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Сессии прохождения опросников
CREATE TABLE research_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    respondent_id TEXT NOT NULL,                   -- Уникальный, постоянный ID для идентификации респондента
    status TEXT DEFAULT 'in_progress' NOT NULL,    -- Статус прохождения (in_progress, completed)
    metadata JSONB DEFAULT '{}'::jsonb,            -- Дополнительный контекст сессии
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Ответы на вопросы в рамках сессий
CREATE TABLE questionnaire_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES research_sessions(id) ON DELETE CASCADE,
    question_id UUID REFERENCES question_bank(id) ON DELETE RESTRICT,
    response_value JSONB NOT NULL,                 -- Значение ответа (число, строка, массив выбранных опций)
    answered_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Уникальность ответа на конкретный вопрос в рамках одной сессии
    CONSTRAINT unique_session_question UNIQUE (session_id, question_id)
);

-- Индексы для ускорения выборки
CREATE INDEX idx_question_bank_code ON question_bank(code);
CREATE INDEX idx_sessions_respondent ON research_sessions(respondent_id);
CREATE INDEX idx_responses_session ON questionnaire_responses(session_id);
