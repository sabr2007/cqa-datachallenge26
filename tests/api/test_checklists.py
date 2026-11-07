import copy
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.api.conftest import ApiFactory
from tests.api.helpers import assert_error, checklist_doc


def new_version_body(**changes: Any) -> dict[str, Any]:
    doc = {key: value for key, value in checklist_doc().items() if key != "version"}
    return {**doc, **changes}


def test_seeded_checklist_is_listed_as_version_one(api: TestClient) -> None:
    body = api.get("/api/checklists").json()

    assert body == {
        "items": [
            {
                "id": "chat-quality",
                "title": "Чек-лист качества чатов",
                "latest_version": 1,
                "versions": [
                    {
                        "version": 1,
                        "created_at": body["items"][0]["versions"][0]["created_at"],
                        "note": "Исходная версия из config/checklists/chat-default.json",
                        "sandbox": False,
                    }
                ],
            }
        ]
    }


def test_default_alias_returns_latest_version_of_chat_quality(api: TestClient) -> None:
    default = api.get("/api/checklists/default").json()
    explicit = api.get("/api/checklists/chat-quality?version=1").json()

    assert default == checklist_doc()
    assert explicit == default


def test_new_version_becomes_latest_and_keeps_old_one(api: TestClient) -> None:
    criteria = copy.deepcopy(checklist_doc()["criteria"])
    criteria[4] = {**criteria[4], "title": "Вежливость", "weight": 20}
    body = new_version_body(criteria=criteria, note="Заменён критерий 05", version=99)

    response = api.post("/api/checklists/chat-quality/versions", json=body)

    assert response.status_code == 201
    created = response.json()
    assert created["version"] == 2  # version из тела игнорируется
    assert created["id"] == "chat-quality"
    assert "note" not in created
    assert api.get("/api/checklists/default").json()["criteria"][4]["title"] == "Вежливость"
    assert api.get("/api/checklists/default?version=1").json() == checklist_doc()
    listing = api.get("/api/checklists").json()["items"][0]
    assert listing["latest_version"] == 2
    assert [v["note"] for v in listing["versions"]][1] == "Заменён критерий 05"


def test_sandbox_version_is_not_latest_but_readable_by_number(api: TestClient) -> None:
    body = new_version_body(title="Эксперимент", sandbox=True, note="песочница")

    created = api.post("/api/checklists/default/versions", json=body).json()

    assert created["version"] == 2
    listing = api.get("/api/checklists").json()["items"][0]
    assert listing["latest_version"] == 1
    assert [v["sandbox"] for v in listing["versions"]] == [False, True]
    assert api.get("/api/checklists/default").json()["version"] == 1
    assert api.get("/api/checklists/chat-quality?version=2").json()["title"] == "Эксперимент"


def test_new_checklist_id_starts_from_version_one(api: TestClient) -> None:
    body = {key: value for key, value in new_version_body().items() if key != "id"}

    response = api.post("/api/checklists/call-quality/versions", json=body)

    assert response.status_code == 201
    assert response.json()["id"] == "call-quality"
    assert response.json()["version"] == 1
    ids = [item["id"] for item in api.get("/api/checklists").json()["items"]]
    assert ids == ["call-quality", "chat-quality"]


@pytest.mark.parametrize(
    ("path", "status_code", "code"),
    [
        ("/api/checklists/chat-quality?version=7", 404, "checklist_version_not_found"),
        ("/api/checklists/unknown", 404, "checklist_not_found"),
        ("/api/checklists/bad!id", 400, "invalid_checklist_id"),
        ("/api/checklists/chat-quality?version=0", 400, "invalid_version"),
        ("/api/checklists/chat-quality?version=abc", 400, "invalid_request"),
    ],
)
def test_checklist_lookup_errors(api: TestClient, path: str, status_code: int, code: str) -> None:
    assert_error(api.get(path), status_code, code)


def _criteria_with(index: int, **changes: Any) -> list[dict[str, Any]]:
    criteria = copy.deepcopy(checklist_doc()["criteria"])
    criteria[index] = {**criteria[index], **changes}
    return criteria


@pytest.mark.parametrize(
    ("changes", "fragment"),
    [
        ({"criteria": _criteria_with(1, id="c01")}, "id критерия «c01» повторяется"),
        ({"criteria": _criteria_with(0, weight=-1)}, "критерий c01: вес — число не меньше 0"),
        ({"criteria": _criteria_with(0, weight=True)}, "критерий c01: вес — число не меньше 0"),
        ({"criteria": _criteria_with(3, scale=[{"value": 20, "label": "Всё"}])}, "шкала"),
        (
            {"criteria": _criteria_with(3, scale=[{"value": 5, "label": "a"}] * 2)},
            "значения ступеней шкалы повторяются",
        ),
        ({"criteria": _criteria_with(0, yes="  ")}, "опишите условие «Да»"),
        ({"criteria": _criteria_with(0, answerType="text")}, "answerType"),
        ({"criteria": []}, "нужен хотя бы один критерий"),
        (
            {"sections": [{"id": "s", "title": "Секция", "criteria": ["c01", "c99"]}]},
            "ссылается на несуществующий критерий «c99»",
        ),
        (
            {
                "sections": [
                    {"id": "a", "title": "A", "criteria": ["c01"]},
                    {"id": "b", "title": "B", "criteria": ["c01"]},
                ]
            },
            "критерий c01 входит в две секции",
        ),
        ({"id": "other"}, "не совпадает с чек-листом в адресе"),
        ({"title": ""}, "название чек-листа"),
        ({"rules": {"maxTotal": 0}}, "rules.maxTotal"),
    ],
)
def test_invalid_checklist_is_rejected_with_reason(
    api: TestClient, changes: dict[str, Any], fragment: str
) -> None:
    response = api.post("/api/checklists/chat-quality/versions", json=new_version_body(**changes))

    error = assert_error(response, 400, "invalid_checklist")
    assert fragment in error["message"]
    assert api.get("/api/checklists").json()["items"][0]["latest_version"] == 1


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ([1, 2], "invalid_body"),
        ({**new_version_body(), "sandbox": "yes"}, "invalid_sandbox"),
        ({**new_version_body(), "note": "x" * 501}, "invalid_note"),
    ],
)
def test_invalid_version_body_gives_400(api: TestClient, body: Any, code: str) -> None:
    assert_error(api.post("/api/checklists/chat-quality/versions", json=body), 400, code)


def test_broken_seed_file_gives_checklist_unavailable(make_api: ApiFactory, tmp_path) -> None:
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    client = make_api(checklist_path=broken)

    assert_error(client.get("/api/checklists/default"), 500, "checklist_unavailable")
    assert client.get("/api/checklists").json() == {"items": []}
    assert str(tmp_path) not in client.get("/api/checklists/default").text
