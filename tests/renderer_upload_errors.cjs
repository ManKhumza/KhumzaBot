/* Exercise the production event handlers with rejected IPC boundaries. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'apps/desktop/renderer/node_modules/typescript'));
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
const errorModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync(path.join(root, 'apps/desktop/renderer/src/utils/errors.ts'), 'utf8'),
  { compilerOptions },
).outputText, { exports: errorModule.exports, Error });

function handler(name, globals) {
  const file = path.join(root, 'apps/desktop/renderer/src/pages/Knowledge.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer, `Missing production handler ${name}`);
  return vm.runInNewContext(ts.transpileModule(`(${initializer.getText(source)})`, { compilerOptions }).outputText,
    { ...errorModule.exports, Error, ...globals });
}

test('Upload failure is readable, sanitized in the alert and logs, and keeps retry inputs', async () => {
  const calls = [];
  const alerts = [];
  const busy = [];
  const logs = [];
  const detail = 'Only 0 MB is available for ingestion (465 MB free; 512 MB reserved). Unload a chat model and try again.';
  const error = new Error(`Error invoking remote method 'nocai:knowledge:uploadDocuments': Error: ${detail}`);
  const invoke = handler('handleUpload', {
    selectedCollection: { id: 'collection' },
    uploadFiles: [{ path: 'fixture.txt' }],
    nocaiAPI: { knowledge: { uploadDocuments: async (...args) => { calls.push(args); throw error; } } },
    setUploading: value => busy.push(value),
    setUploadError: value => alerts.push(value),
    setShowUploadDialog: () => assert.fail('Failed upload closed the retry dialog'),
    setUploadFiles: () => assert.fail('Failed upload discarded selected documents'),
    handleSelectCollection: () => assert.fail('Failed upload refreshed as success'),
    console: { error: (...args) => logs.push(args.map(String).join(' ')) },
  });
  await invoke();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'collection');
  assert.equal(calls[0][1][0], 'fixture.txt');
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(alerts, [null, detail]);
  assert.ok(logs.every(line => !line.includes('Error invoking remote method')));
});

test('Document picker failure removes IPC wrappers and redacts sensitive details', async () => {
  const alerts = [];
  const sensitiveFixture = ['fixture', 'credential'].join('-');
  const error = new Error(`Error invoking remote method 'nocai:knowledge:selectDocuments': Error: Picker unavailable; token=${sensitiveFixture}`);
  await handler('handleBrowseDocuments', {
    nocaiAPI: { knowledge: { selectDocuments: async () => { throw error; } } },
    setUploadError: value => alerts.push(value),
    addUploadFiles: () => assert.fail('Failed picker added files'),
  })();
  assert.equal(alerts[0], null);
  assert.equal(alerts[1], 'Picker unavailable; token=[redacted]');
  assert.ok(!alerts[1].includes(sensitiveFixture));
});
