import os
import re
from typing import Any
from uuid import UUID

from supabase import Client, create_client

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
QUESTION_CODE = re.compile(r"^[A-Z0-9]+(?:_[A-Z0-9]+)*$")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError(
        "SUPABASE_URL and the server-side SUPABASE_SERVICE_ROLE_KEY are required"
    )

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


def _uuid_v4(value: Any, field: str) -> str:
    try:
        parsed = UUID(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be a UUID") from error
    if parsed.version != 4:
        raise ValueError(f"{field} must be a UUID v4")
    return str(parsed)


def validate_question_definition(question: dict) -> dict:
    if not isinstance(question, dict):
        raise ValueError("Question definition must be an object")
    required = ("question_id", "code", "version", "type", "prompt", "scale", "status")
    missing = [field for field in required if question.get(field) in (None, "")]
    if missing:
        raise ValueError(f"Question definition is missing: {', '.join(missing)}")

    _uuid_v4(question["question_id"], "question_id")
    if not QUESTION_CODE.fullmatch(str(question["code"])):
        raise ValueError("Question code must use canonical uppercase ASCII tokens")
    if not isinstance(question["version"], int) or question["version"] < 1:
        raise ValueError("Question version must be a positive integer")
    if question["status"] not in {"draft", "trial", "active"}:
        raise ValueError("Question status must be draft, trial, or active")
    if not isinstance(question["scale"], dict):
        raise ValueError("Question scale must be an object")
    if not isinstance(question.get("options", []), list):
        raise ValueError("Question options must be an array")
    return question


def save_question_bank_package(package_data: dict) -> dict:
    if package_data.get("schema") != "research_os.question_bank":
        raise ValueError("research_os.question_bank package is required")
    if package_data.get("schema_version") != 2:
        raise ValueError("Question-bank schema version 2 is required")

    response = supabase.rpc(
        "save_question_bank_package", {"package_data": package_data}
    ).execute()
    return response.data


def save_question_to_bank(
    question_data: dict,
    bank_id: str,
    bank_version: int = 1,
) -> dict:
    """
    Attach a canonical question version to an existing draft bank version.

    The question keeps its own UUID/version. The database creates only a
    membership relation; it never rewrites the question as bank-owned.
    """
    question = validate_question_definition(question_data)
    canonical_bank_id = _uuid_v4(bank_id, "bank_id")
    if not isinstance(bank_version, int) or bank_version < 1:
        raise ValueError("bank_version must be a positive integer")

    response = supabase.rpc(
        "attach_question_to_draft_bank",
        {
            "p_bank_id": canonical_bank_id,
            "p_bank_version": bank_version,
            "p_question": question,
        },
    ).execute()
    return response.data
