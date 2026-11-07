import pytest

from app.errors import BadRequestError
from app.validation import is_valid_id, require_conversation_id, require_group_id


@pytest.mark.parametrize("value", ["DEV", "p1-ru-001", "a", "A_b-9", "x" * 64])
def test_valid_ids_are_accepted(value: str) -> None:
    assert is_valid_id(value)


@pytest.mark.parametrize(
    "value",
    ["", "x" * 65, "DEV!", "a b", "a/b", "a.b", "abc\n", "ДЕВ", "a%2Fb", None, 123],
)
def test_invalid_ids_are_rejected(value: object) -> None:
    assert not is_valid_id(value)


def test_require_group_id_raises_400_with_specific_code() -> None:
    with pytest.raises(BadRequestError) as caught:
        require_group_id("../etc")

    assert caught.value.status_code == 400
    assert caught.value.code == "invalid_group_id"


def test_require_conversation_id_raises_400_with_specific_code() -> None:
    with pytest.raises(BadRequestError) as caught:
        require_conversation_id("p1 ru")

    assert caught.value.code == "invalid_conversation_id"


def test_require_returns_value_unchanged_when_valid() -> None:
    assert require_group_id("DEV") == "DEV"
    assert require_conversation_id("p4-ru-001") == "p4-ru-001"
