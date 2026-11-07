import codecs
import csv
import io

from fastapi.testclient import TestClient

from tests.api.fakes import FakeEvaluator
from tests.api.helpers import CHAT, GROUP, OTHER_CHAT, assert_error, decide, evaluate, file_appeal


def test_json_export_has_latest_regular_evaluations(api: TestClient, engine: FakeEvaluator) -> None:
    evaluate(api)
    engine.answers[CHAT] = {"c04": 15}
    latest = evaluate(api)
    evaluate(api, OTHER_CHAT, purpose="sandbox")

    response = api.get(f"/api/export?group_id={GROUP}")

    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith('attachment; filename="cqa-DEV-')
    body = response.json()
    assert body["group_id"] == GROUP
    assert [item["evaluation_id"] for item in body["items"]] == [latest["id"]]
    item = body["items"][0]
    assert (item["conversation_id"], item["language"], item["checklist_version"]) == (CHAT, "RU", 1)
    c04 = next(c for c in item["criteria"] if c["criterion_id"] == "c04")
    assert (c04["answer"], c04["final_answer"], c04["points"]) == (15, 15, 15.0)
    assert (item["total"], item["critical_flag"]) == (95.0, False)


def test_csv_export_is_excel_friendly(api: TestClient, engine: FakeEvaluator) -> None:
    engine.answers[CHAT] = {"c02": "na", "c08": "yes"}
    evaluation = evaluate(api)
    appeal = file_appeal(api, evaluation["id"], "c08")
    decide(api, appeal["id"], action="change", new_answer="no", reason='=HYPERLINK("x")')

    response = api.get(f"/api/export?group_id={GROUP}&format=csv")

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.headers["content-disposition"].endswith('.csv"')
    raw = response.content
    assert raw.startswith(codecs.BOM_UTF8)
    text = raw.decode("utf-8-sig")
    assert "\r\n" in text
    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    header, row = rows[0], rows[1]
    cells = dict(zip(header, row, strict=True))
    assert header[:3] == ["group_id", "conversation_id", "language"]
    assert header.index("c01_answer") < header.index("c08_final_points") < header.index("total")
    assert cells["conversation_id"] == CHAT
    assert (cells["c02_answer"], cells["c02_points"]) == ("na", "")
    assert cells["c01_points"] == "11,76"  # десятичная запятая
    assert (cells["c08_answer"], cells["c08_final_answer"]) == ("yes", "no")
    assert (cells["critical_flag"], cells["total"]) == ("no", "100")
    assert cells["critical_note"] == '\'=HYPERLINK("x")'  # формула не выполнится в Excel
    assert cells["cost_usd"] == "0,0123"


def test_export_without_evaluations_is_empty(api: TestClient) -> None:
    assert api.get("/api/export?group_id=DEV").json()["items"] == []
    text = api.get("/api/export?group_id=DEV&format=csv").content.decode("utf-8-sig")
    assert text.startswith("group_id;conversation_id;language;")


def test_export_rejects_unknown_format(api: TestClient) -> None:
    assert_error(api.get("/api/export?group_id=DEV&format=xlsx"), 400, "invalid_format")
    assert_error(api.get("/api/export?group_id=DEV!"), 400, "invalid_group_id")
