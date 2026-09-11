"""Reject a superficially green suite that omits required product risk areas."""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEST_ROOT = ROOT / "tests"
MINIMUM_TESTS = 15

# These names mirror the mandatory coverage sections in the remediation prompt.
# A category is evidence of coverage, not proof by itself; pytest must still run it.
REQUIRED_CATEGORIES: dict[str, tuple[str, ...]] = {
    "module imports": ("import", "module"),
    "onboarding and authentication": ("onboard", "bootstrap", "login", "password"),
    "transport secret": ("transport_secret", "backend_token"),
    "IPC contract": ("ipc", "preload", "contract"),
    "conversation and cancellation": ("conversation", "chat", "cancel", "generation"),
    "embedding runtime": ("embedding", "384"),
    "document ingestion": ("ingest", "document", "upload"),
    "retrieval": ("retrieval", "search", "vector"),
    "audit": ("audit",),
    "settings persistence": ("settings", "persistence"),
    "backup and restore": ("backup", "restore", "archive"),
    "package integrity": ("package", "artifact", "checksum", "version_consistency"),
    "installed application smoke": ("installed", "packaged", "desktop_smoke"),
    "fault injection": ("fault", "crash", "port_collision", "restart_budget"),
    "soak and resource leaks": ("soak", "leak", "orphan_process"),
}


def discover_test_evidence(test_root: Path = TEST_ROOT) -> tuple[list[str], list[str]]:
    names: list[str] = []
    parse_errors: list[str] = []
    for path in sorted(test_root.rglob("test_*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError, UnicodeError) as exc:
            parse_errors.append(f"{path.name}: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                docstring = ast.get_docstring(node) or ""
                checks = [item for item in ast.walk(node) if isinstance(item, ast.Assert)]
                checked_calls = [
                    item for item in ast.walk(node)
                    if isinstance(item, ast.Call) and (
                        (isinstance(item.func, ast.Attribute) and item.func.attr in {"raises", "check_call", "check_output"})
                        or any(arg.arg == "check" and isinstance(arg.value, ast.Constant) and arg.value.value is True for arg in item.keywords)
                    )
                ]
                if not checks and not checked_calls:
                    parse_errors.append(f"{path.name}:{node.lineno}: {node.name} has no executable outcome assertion")
                    continue
                if checks and not checked_calls and all(
                    isinstance(item.test, ast.Call) and isinstance(item.test.func, ast.Name)
                    and item.test.func.id == "hasattr" for item in checks
                ):
                    parse_errors.append(f"{path.name}:{node.lineno}: {node.name} only checks method existence")
                    continue
                names.append(f"{path.stem}.{node.name} {docstring}".lower())
    return names, parse_errors


def main() -> int:
    evidence, parse_errors = discover_test_evidence()
    corpus = "\n".join(evidence)
    missing = [
        category
        for category, terms in REQUIRED_CATEGORIES.items()
        if not any(term.lower() in corpus for term in terms)
    ]
    result = {
        "discovered_tests": len(evidence),
        "minimum_tests": MINIMUM_TESTS,
        "required_categories": sorted(REQUIRED_CATEGORIES),
        "missing_categories": missing,
        "parse_errors": parse_errors,
        "passed": len(evidence) >= MINIMUM_TESTS and not missing and not parse_errors,
    }
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
