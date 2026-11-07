"""Движок оценки диалогов по чек-листу (интерфейс для бэкенда — docs/CONTRACT.md).

evaluate_conversation(conversation, checklist, *, models=None, reuse=None) -> Evaluation
score_evaluation(checklist, answers) -> {"criteria", "sections", "total", ...}
list_models() -> [{"id", "provider", "label", "available", "default", "price"}]
compute_accuracy(evaluations, gold, split=None, ...) -> отчёт для /api/metrics/accuracy
"""

from app.engine.accuracy import compute_accuracy
from app.engine.pipeline import evaluate_conversation
from app.engine.providers import default_models, list_models
from app.engine.scoring import (
    AnswerError,
    allowed_answers,
    critical_flag,
    normalize_answer,
    score_evaluation,
)

__all__ = [
    "AnswerError",
    "allowed_answers",
    "compute_accuracy",
    "critical_flag",
    "default_models",
    "evaluate_conversation",
    "list_models",
    "normalize_answer",
    "score_evaluation",
]
