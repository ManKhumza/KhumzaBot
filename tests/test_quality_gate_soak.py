"""Exercise the gate's real desktop dispatch against an isolated recording child.

Only the npm process boundary is replaced. PowerShell parses the authoritative
gate, loads its functions, and executes its actual desktop command expression;
no application process or user profile is involved in these harness tests.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "scripts/quality-gate.ps1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
DEVELOPMENT = "Real desktop end-to-end workflows"
PACKAGED = "Packaged desktop end-to-end workflows"


def _ps_literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _run_desktop_step(tmp_path, label, package, minutes, inherited, child_exit=0):
    recorder = tmp_path / "record_child.py"
    capture = tmp_path / "child.json"
    recorder.write_text(
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['SOAK_TEST_CAPTURE']).write_text(json.dumps({"
        "'minutes': os.environ.get('NOC_AI_E2E_SOAK_MINUTES'), "
        "'arguments': sys.argv[2:]}), encoding='utf-8')\n"
        "sys.exit(int(sys.argv[1]))\n",
        encoding="utf-8",
    )
    inherited_value = "$null" if inherited is None else _ps_literal(inherited)
    script = f"""
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile({_ps_literal(GATE)}, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -ne 0) {{ throw 'Quality gate has PowerShell parse errors' }}
$ProjectRoot = {_ps_literal(ROOT)}
$LogDirectory = {_ps_literal(tmp_path)}
$Python = {_ps_literal(sys.executable)}
$Recorder = {_ps_literal(recorder)}
$SoakMinutes = {minutes}
$Package = ${str(package).lower()}
$ChildExit = {child_exit}
$Label = {_ps_literal(label)}
$script:Results = [System.Collections.Generic.List[object]]::new()
foreach ($Definition in $Ast.EndBlock.Statements) {{
    if ($Definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {{
        Invoke-Expression $Definition.Extent.Text
    }}
}}
function npm.cmd {{
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    & $Python $Recorder $ChildExit @Arguments
}}
$env:SOAK_TEST_CAPTURE = {_ps_literal(capture)}
$env:NOC_AI_E2E_SOAK_MINUTES = {inherited_value}
$Commands = @($Ast.FindAll({{
    param($Node)
    $Node -is [System.Management.Automation.Language.CommandAst] -and
        $Node.CommandElements.Count -gt 1 -and
        $Node.CommandElements[1] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $Node.CommandElements[1].Value -eq $Label
}}, $true))
if ($Commands.Count -ne 1) {{ throw 'Expected one authoritative desktop gate invocation' }}
Invoke-Expression $Commands[0].Extent.Text
$Result = @{{
    gate = @($script:Results | Where-Object {{ $_.name -eq $Label }})[0]
    restored_minutes = $env:NOC_AI_E2E_SOAK_MINUTES
}}
Write-Output ('QUALITY_SOAK_TEST_RESULT=' + ($Result | ConvertTo-Json -Depth 6 -Compress))
"""
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    prefix = "QUALITY_SOAK_TEST_RESULT="
    result = json.loads(next(line[len(prefix):] for line in completed.stdout.splitlines() if line.startswith(prefix)))
    return result, json.loads(capture.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "label,package,minutes,inherited,expected",
    [
        (DEVELOPMENT, False, 60, "17", 60),
        (DEVELOPMENT, False, 0, "17", 0),
        (DEVELOPMENT, False, 60, None, 60),
        (DEVELOPMENT, True, 60, "17", 0),
        (PACKAGED, True, 60, "17", 60),
        (PACKAGED, True, 0, "17", 0),
        (PACKAGED, True, 60, None, 60),
    ],
)
def test_requested_soak_reaches_only_selected_desktop_child_and_restores_environment(
    tmp_path, label, package, minutes, inherited, expected,
):
    result, child = _run_desktop_step(tmp_path, label, package, minutes, inherited)
    assert child["minutes"] == str(expected)
    assert child["arguments"] == ["run", "test:e2e"]
    assert result["gate"]["passed"] is True
    assert result["gate"]["soak_minutes"] == expected
    assert result["restored_minutes"] == inherited


@pytest.mark.parametrize("label,package", [(DEVELOPMENT, False), (PACKAGED, True)])
def test_failed_soak_child_fails_gate_and_restores_environment(tmp_path, label, package):
    result, child = _run_desktop_step(tmp_path, label, package, 60, "17", child_exit=7)
    assert child["minutes"] == "60"
    assert result["gate"]["passed"] is False
    assert result["gate"]["detail"] == "exit 7"
    assert result["gate"]["soak_minutes"] == 60
    assert result["restored_minutes"] == "17"


@pytest.mark.parametrize("minutes,valid", [(-1, False), (0, True), (60, True), (180, True), (181, False)])
def test_soak_parameter_validation_matches_workflow_supported_duration(minutes, valid):
    # Run only the actual parameter block, so a validation regression can never
    # start the full build, tests, or an app from inside the pytest suite.
    script = f"""
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile({_ps_literal(GATE)}, [ref]$Tokens, [ref]$ParseErrors)
$Validate = [scriptblock]::Create($Ast.ParamBlock.Extent.Text + "`n'accepted'")
try {{ & $Validate -SoakMinutes {minutes} -ErrorAction Stop }} catch {{ exit 2 }}
"""
    completed = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
    )
    assert completed.returncode == (0 if valid else 2), completed.stdout + completed.stderr
