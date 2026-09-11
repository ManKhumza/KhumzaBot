// electron-builder invokes this for app, installer AND uninstaller executables.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function sign(configuration) {
  if (process.env.NOC_AI_SIGN_REQUESTED !== '1') {
    throw new Error('Signing hook requires an explicitly requested signed build');
  }
  execFileSync(process.env.NOC_AI_SIGN_POWERSHELL || 'powershell.exe', [
    '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'sign-windows.ps1'),
    '-Path', configuration.path,
  ], { windowsHide: true, stdio: 'pipe', timeout: 120000 });
};
