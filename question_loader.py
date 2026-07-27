import os
import uuid
from supabase import create_client, Client
from questionnaire_components import validate_question_measurement_contract

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("No se han configurado SUPABASE_URL o SUPABASE_KEY/SUPABASE_ANON_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def save_question_to_bank(question_data: dict, bank_id: str) -> dict:
    """
    Valida el contrato de medición y guarda/actualiza la pregunta 
    asociándola al bank_id especificado.
    """
    validation_result = validate_question_measurement_contract(
        question_type=question_data.get("question_type"),
        response_type=question_data.get("response_type"),
        scale_type=question_data.get("scale_type"),
        presentation_type=question_data.get("presentation_type")
    )
    
    if not validation_result.get("is_valid", True):
        raise ValueError(f"Error de contrato psicométrico: {validation_result.get('error')}")

    payload = {
        "id": question_data.get("id") or str(uuid.uuid4()),
        "bank_id": bank_id,  # Точечная привязка к нужному банку вопросов
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

    response = supabase.table("question_bank").upsert(payload, on_conflict="id").execute()
    return response.data
