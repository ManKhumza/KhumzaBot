"""Clean-build dependency ordering and the CI prerequisites it must provision."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "scripts/build-all.ps1"
WORKFLOW = ROOT / ".github/workflows/build-windows.yml"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


def _literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def _workflow():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _run_build_dispatch(tmp_path, node_version="24.0.0", flags=()):
    """Execute authoritative PowerShell control flow with recorded tool calls.

    Package downloads, compilers and pytest are process boundaries here, not
    synthetic product tests. A missing npm install raises at the pytest boundary.
    All script filesystem operations run against an isolated temporary checkout.
    """
    for relative in ["scripts", "backend", ".venv", "apps/desktop/electron", "apps/desktop/renderer"]:
        (tmp_path / relative).mkdir(parents=True, exist_ok=True)
    (tmp_path / "VERSION").write_text("1.1.0", encoding="utf-8")
    (tmp_path / "scripts/build-python-runtime.ps1").write_text(
        "$global:BuildCalls.Add(@{file='embedded-runtime'; arguments=@(); directory=(Get-Location).Path})\n",
        encoding="utf-8",
    )
    script = f"""
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile({_literal(BUILD)}, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) {{ throw 'Build script has PowerShell syntax errors' }}
# Keep real conditionals and dispatch expressions; substitute only the tool
# invocation boundary so this regression never builds or alters the repository.
$Body = @($Ast.EndBlock.Statements | Where-Object {{
    -not ($_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Invoke-Checked')
}} | ForEach-Object {{ $_.Extent.Text }}) -join "`n"
$IsolatedScript = {_literal(tmp_path / 'scripts/build-all.ps1')}
Set-Content -LiteralPath $IsolatedScript -Value ($Ast.ParamBlock.Extent.Text + "`n" + $Body)
$global:BuildCalls = [System.Collections.Generic.List[object]]::new()
function node {{ $global:LASTEXITCODE = 0; 'v{node_version}' }}
function Invoke-Checked([string]$File, [string[]]$Arguments) {{
    $global:BuildCalls.Add(@{{file=$File; arguments=$Arguments; directory=(Get-Location).Path}})
    if ($Arguments -contains 'pytest') {{
        $Installed = @($global:BuildCalls | Where-Object {{
            $_.file -eq 'npm.cmd' -and $_.arguments[0] -eq 'ci' -and $_.directory -like '*electron'
        }})
        if ($Installed.Count -ne 1) {{ throw 'Backend test dependency missing: Electron npm ci must run first.' }}
        $RendererInstalled = @($global:BuildCalls | Where-Object {{
            $_.file -eq 'npm.cmd' -and $_.arguments[0] -eq 'ci' -and $_.directory -like '*renderer'
        }})
        if ($RendererInstalled.Count -ne 1) {{ throw 'Backend test dependency missing: renderer npm ci must run first.' }}
    }}
}}
$Failure = $null
try {{ & $IsolatedScript -SkipRuntime -SkipPackaging {' '.join(flags)} }} catch {{ $Failure = $_.Exception.Message }}
Write-Output ('BUILD_DISPATCH_RESULT=' + (@{{calls=@($global:BuildCalls.ToArray()); error=$Failure}} | ConvertTo-Json -Depth 6 -Compress))
"""
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=tmp_path, capture_output=True, text=True, timeout=30, check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    prefix = "BUILD_DISPATCH_RESULT="
    return json.loads(next(line[len(prefix):] for line in completed.stdout.splitlines() if line.startswith(prefix)))


@pytest.mark.parametrize("flags", [(), ("-SkipFrontend",), ("-SkipBackend",), ("-SkipFrontend", "-SkipBackend")])
def test_build_installs_electron_dependencies_once_before_backend_test_dispatch(tmp_path, flags):
    result = _run_build_dispatch(tmp_path, flags=flags)
    assert result["error"] is None
    calls = result["calls"]
    installs = [i for i, call in enumerate(calls) if call["file"] == "npm.cmd"
                and call["arguments"][0] == "ci" and call["directory"].endswith("electron")]
    assert len(installs) == 1
    tests = [i for i, call in enumerate(calls) if "pytest" in call["arguments"]]
    if "-SkipBackend" in flags:
        assert tests == []
    else:
        assert len(tests) == 1 and installs[0] < tests[0]
    frontend_installs = [call for call in calls if call["file"] == "npm.cmd"
                        and call["arguments"][0] == "ci" and call["directory"].endswith("renderer")]
    assert len(frontend_installs) == (0 if "-SkipFrontend" in flags and "-SkipBackend" in flags else 1)


@pytest.mark.parametrize("version,accepted", [("20.20.0", False), ("22.11.0", False), ("22.12.0", True), ("24.0.0", True)])
def test_build_rejects_node_below_locked_electron_requirement_before_install(tmp_path, version, accepted):
    result = _run_build_dispatch(tmp_path, node_version=version, flags=("-SkipBackend", "-SkipFrontend"))
    if accepted:
        assert result["error"] is None
        assert len(result["calls"]) > 0
    else:
        assert "22.12.0" in (result["error"] or "")
        assert result["calls"] == []


def test_readme_and_ci_node_versions_meet_locked_electron_engine():
    lock = json.loads((ROOT / "apps/desktop/electron/package-lock.json").read_text(encoding="utf-8"))
    engine = lock["packages"]["node_modules/electron"]["engines"]["node"]
    minimum = tuple(map(int, re.search(r"(\d+)\.(\d+)\.(\d+)", engine).groups()))
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    advertised = re.search(r"Node\.js (\d+)(?:\.(\d+)\.(\d+))?", readme)
    advertised_version = tuple(int(part or 0) for part in advertised.groups())
    ci_major = int(str(_workflow()["env"]["NODE_VERSION"]).split(".")[0])
    assert advertised_version >= minimum
    assert ci_major > minimum[0], "A CI major-only selector must stay above the engine's minor floor"


def test_ci_bootstraps_build_dependencies_before_independent_gate():
    steps = _workflow()["jobs"]["build-and-verify"]["steps"]
    commands = [step.get("run", "") for step in steps]
    bootstrap = next((i for i, command in enumerate(commands) if "build-all.ps1 -SkipPackaging" in command), None)
    gate = next(i for i, command in enumerate(commands) if "quality-gate.ps1 -Package" in command)
    assert bootstrap is not None and bootstrap < gate
    # The authoritative build owns constrained pip installs and npm/llama setup.
    assert not any("pip install" in command for command in commands)


def test_ci_missing_local_chat_fixture_fails_with_actionable_prerequisite(tmp_path):
    steps = _workflow()["jobs"]["build-and-verify"]["steps"]
    guard = next((step for step in steps if step.get("name") == "Check local chat model fixture"), None)
    assert guard is not None
    environment = os.environ.copy()
    environment["NOC_AI_CHAT_TEST_MODEL"] = str(tmp_path / "missing.gguf")
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", guard["run"]],
        cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30, check=False,
    )
    assert completed.returncode != 0
    assert "NOC_AI_CHAT_TEST_MODEL" in completed.stderr
    assert "local" in completed.stderr.lower()
