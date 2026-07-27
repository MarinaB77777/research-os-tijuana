import os
import uuid
from supabase import create_client, Client
from questionnaire_components import validate_question_measurement_contract

# Инициализация клиента Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Не заданы переменные окружения SUPABASE_URL или SUPABASE_KEY/SUPABASE_ANON_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def save_question_to_bank(question_data: dict) -> dict:
    """
    Валидирует измерительный контракт и сохраняет/обновляет вопрос в Supabase.
    """
    # 1. Проверка измерительного контракта
    validation_result = validate_question_measurement_contract(
        question_type=question_data.get("question_type"),
        response_type=question_data.get("response_type"),
        scale_type=question_data.get("scale_type"),
        presentation_type=question_data.get("presentation_type")
    )
    
    if not validation_result.get("is_valid", True):
        raise ValueError(f"Ошибка измерительного контракта: {validation_result.get('error')}")

    # 2. Подготовка данных для таблицы question_bank
    payload = {
        "id": question_data.get("id") or str(uuid.uuid4()),
        "code": question_data["code"],
        "schema_version": question_data.get("schema_version", "questionnaire-components-1"),
        "title": question_data["title"],
        "question_type": question_data["question_type"],
        "response_type": question_data["response_type"],
        "scale_type": question_data.get("scale_type"),
        "presentation_type": question_data.get("presentation_type"),
        "validation": question_data.get("validation", {}),
        "options": question_data.get("options", [])
    }

    # 3. Сохранение в Supabase (upsert по первичному ключу id)
    response = supabase.table("question_bank").upsert(payload, on_conflict="id").execute()
    
    return response.data
