import json
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "scripts" / "nemotron-harness-core.psm1"
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


def _run_powershell(script: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def test_monitored_process_streams_progress_and_returns_exit_code(tmp_path: Path) -> None:
    stdout_log = tmp_path / "agent.stdout.log"
    stderr_log = tmp_path / "agent.stderr.log"
    command = (
        f"Import-Module '{CORE}' -Force; "
        "$child = @('-NoProfile','-NonInteractive','-Command',"
        "'Write-Output progress-one; Start-Sleep -Milliseconds 300; Write-Output progress-two'); "
        f"$result = Invoke-MonitoredProcess -FilePath '{POWERSHELL}' -ArgumentList $child "
        f"-WorkingDirectory '{ROOT}' -StandardOutputPath '{stdout_log}' "
        f"-StandardErrorPath '{stderr_log}' -MaxRuntime ([timespan]::FromSeconds(10)) "
        "-InactivityTimeout ([timespan]::FromSeconds(5)) "
        "-HeartbeatInterval ([timespan]::FromSeconds(1)) -ActivityName 'test-agent'; "
        "$result | ConvertTo-Json -Compress"
    )
    completed = _run_powershell(command)

    assert completed.returncode == 0, completed.stderr
    assert "progress-one" in completed.stdout
    assert "progress-two" in completed.stdout
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    assert result["ExitCode"] == 0
    assert result["TimedOut"] is False


def test_monitored_process_stops_a_silent_hang_with_diagnostic(tmp_path: Path) -> None:
    stdout_log = tmp_path / "silent.stdout.log"
    stderr_log = tmp_path / "silent.stderr.log"
    command = (
        f"Import-Module '{CORE}' -Force; "
        "$child = @('-NoProfile','-NonInteractive','-Command',"
        "'Write-Output started; Start-Sleep -Seconds 30'); "
        f"$result = Invoke-MonitoredProcess -FilePath '{POWERSHELL}' -ArgumentList $child "
        f"-WorkingDirectory '{ROOT}' -StandardOutputPath '{stdout_log}' "
        f"-StandardErrorPath '{stderr_log}' -MaxRuntime ([timespan]::FromSeconds(10)) "
        "-InactivityTimeout ([timespan]::FromSeconds(2)) "
        "-HeartbeatInterval ([timespan]::FromSeconds(1)) -ActivityName 'silent-agent'; "
        "$result | ConvertTo-Json -Compress"
    )
    completed = _run_powershell(command)

    assert completed.returncode == 0, completed.stderr
    assert "silent-agent is running" in completed.stdout
    assert "watchdog stopped" in completed.stdout
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    assert result["ExitCode"] == 124
    assert result["TimedOut"] is True
    assert "no output" in result["TimeoutReason"]
