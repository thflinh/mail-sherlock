"""Keep the evaluation dataset internally consistent as it grows."""

import agent_search
from evals import harness

main = harness.import_main()
EMAILS = harness.load_emails()
QUESTIONS = harness.load_questions()
EMAILS_BY_ID = {e["id"]: e for e in EMAILS}


def _referenced_ids(q: dict) -> list[str]:
    ids = [*q["relevant_ids"], *q.get("forbidden_ids", []), *q.get("context_ids", [])]
    if q.get("open_email_id"):
        ids.append(q["open_email_id"])
    return ids


def test_email_ids_are_unique():
    assert len(EMAILS_BY_ID) == len(EMAILS)


def test_each_email_has_exactly_one_body():
    for e in EMAILS:
        assert ("text" in e) != ("html" in e), e["id"]


def test_question_ids_are_unique():
    assert len({q["id"] for q in QUESTIONS}) == len(QUESTIONS)


def test_questions_reference_existing_emails():
    for q in QUESTIONS:
        missing = [i for i in _referenced_ids(q) if i not in EMAILS_BY_ID]
        assert not missing, (q["id"], missing)


def test_expectations_are_consistent():
    for q in QUESTIONS:
        assert q["split"] in {"dev", "heldout"}, q["id"]
        assert q["expect"] in {"found", "empty", "clarify", "unanswerable"}, q["id"]
        assert bool(q["relevant_ids"]) == (q["expect"] == "found"), q["id"]


def test_expected_answers_are_inside_the_window():
    for q in QUESTIONS:
        for i in q["relevant_ids"]:
            assert EMAILS_BY_ID[i]["age_days"] <= harness.WINDOW_DAYS, (q["id"], i)


def test_filters_and_intents_use_known_fields():
    filter_fields = set(main.FilterOptions.model_fields)
    intent_fields = set(agent_search._fallback("x"))
    for q in QUESTIONS:
        assert set(q.get("filters", {})) <= filter_fields, q["id"]
        assert set(q.get("intent", {})) <= intent_fields, q["id"]


def test_each_thread_stays_in_one_split():
    split_by_thread: dict[str, str] = {}
    for q in QUESTIONS:
        for i in _referenced_ids(q):
            thread = EMAILS_BY_ID[i]["thread"]
            assert split_by_thread.setdefault(thread, q["split"]) == q["split"], (q["id"], thread)
