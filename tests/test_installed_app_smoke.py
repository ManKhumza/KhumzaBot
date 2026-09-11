"""Safety tests for the real desktop smoke harness.

Actual UI/IPC/backend workflows live in electron/e2e and are mandatory gate
steps for both development Electron and the rebuilt packaged executable. These
tests do not pretend a source-only pytest run launches an installed application.
"""
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / 'apps/desktop/electron'


def test_installed_app_smoke_environment_isolated(tmp_path):
    script = r'''
const assert = require('node:assert/strict');
const path = require('node:path');
const { environment } = require('./e2e/fixtures.cjs');
const base = process.argv[1];
process.env.NOC_AI_DATABASE_URL = 'must-not-be-inherited';
process.env.NOC_AI_SESSION_TOKEN = 'must-not-be-inherited';
process.env.ELECTRON_RUN_AS_NODE = '1';
const env = environment(base);
assert.equal(env.NOC_AI_DATABASE_URL, undefined);
assert.equal(env.NOC_AI_SESSION_TOKEN, undefined);
assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
assert.equal(env.APPDATA, path.join(base, 'Roaming'));
assert.equal(env.NOC_AI_DATA_DIR, path.join(base, 'data'));
assert.equal(env.NOC_AI_TEST_PROFILE, base);
'''
    subprocess.run(['node', '-e', script, str(tmp_path)], cwd=ELECTRON, check=True,
                   capture_output=True, text=True, timeout=30)


def test_installed_app_soak_process_metrics_exclude_commandline_and_environment():
    script = r'''
const assert = require('node:assert/strict');
const { processMetrics } = require('./e2e/fixtures.cjs');
const own = processMetrics(process.pid).find(p => p.pid === process.pid);
assert(own.rss > 0 && own.threads > 0 && own.handles > 0);
assert(own.started > 0);
assert.deepEqual(Object.keys(own).sort(), ['handles','name','pid','rss','started','threads']);
'''
    subprocess.run(['node', '-e', script], cwd=ELECTRON, check=True, capture_output=True,
                   text=True, timeout=30)
