"""Поиск диалога в наборе (общий для роутов датасета и оценки)."""

from app.errors import conversation_not_found
from app.models import Conversation
from app.services import Services
from app.validation import require_conversation_id, require_group_id


async def find_conversation(
    services: Services, group_id: str, conversation_id: str, *, refresh: bool = False
) -> Conversation:
    valid_group_id = require_group_id(group_id)
    valid_conversation_id = require_conversation_id(conversation_id)
    dataset = await services.datasets.get(valid_group_id, refresh=refresh)
    conversation = dataset.find(valid_conversation_id)
    if conversation is None:
        raise conversation_not_found(valid_group_id, valid_conversation_id)
    return conversation
