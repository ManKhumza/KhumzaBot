"""Regression checks for the independent test-inventory guard itself."""
from scripts.verify_quality_coverage import discover_test_evidence


def test_quality_inventory_rejects_noop_and_method_existence_only(tmp_path):
    (tmp_path / 'test_empty.py').write_text('def test_empty():\n    pass\ndef test_exists():\n    assert hasattr(object, "__str__")\n')
    names, errors = discover_test_evidence(tmp_path)
    assert names == []
    assert len(errors) == 2
    assert 'no executable outcome' in errors[0]
    assert 'only checks method existence' in errors[1]


def test_quality_inventory_reports_parse_errors_and_accepts_outcome(tmp_path):
    (tmp_path / 'test_bad.py').write_text('def broken(:')
    (tmp_path / 'test_good.py').write_text('def test_behavior():\n    assert sum([2, 3]) == 5\n')
    names, errors = discover_test_evidence(tmp_path)
    assert len(names) == 1 and 'test_behavior' in names[0]
    assert len(errors) == 1 and 'test_bad.py' in errors[0]
