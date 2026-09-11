const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { test, expect, root, processMetrics } = require('./fixtures.cjs');

function logBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const target = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? logBytes(target) : fs.statSync(target).size);
  }, 0);
}

async function signIn(page, password, setup = false) {
  await page.getByLabel('Username', { exact: true }).fill('workflow-admin');
  await page.getByLabel(setup ? 'Administrator password' : 'Password', { exact: true }).fill(password);
  if (setup) await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: setup ? 'Create administrator' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

async function chooseFile(electronApp, filepath) {
  await electronApp.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, filepath);
}

test('local BGE ingestion, cited chat, restart persistence and bounded workflow soak', async ({ page, electronApp, profileDir }, testInfo) => {
  const minutes = Number(process.env.NOC_AI_E2E_SOAK_MINUTES || 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 180) throw new Error('NOC_AI_E2E_SOAK_MINUTES must be between 0 and 180');
  test.setTimeout(Math.max(600000, minutes * 60000 + 600000));
  const modelPath = process.env.NOC_AI_CHAT_TEST_MODEL || path.join(root, 'resources/models/Qwen3-4B-Q4_K_M.gguf');
  if (!fs.existsSync(modelPath)) throw new Error('Real chat GGUF fixture absent: supply NOC_AI_CHAT_TEST_MODEL or resources/models/Qwen3-4B-Q4_K_M.gguf');

  const password = `${randomBytes(20).toString('hex')}Aa!`;
  await expect(page.getByText('Create your administrator', { exact: true })).toBeVisible();
  await signIn(page, password, true);
  await expect.poll(async () => page.evaluate(async () => {
    const health = await window.nocai.system.getHealth();
    return health.components?.embeddingRuntime?.status === 'healthy' && health.components?.vectorStore?.dimension === 384;
  }), { timeout: 90000, message: 'Bundled BGE runtime must be healthy with a 384-dimensional vector index' }).toBe(true);

  await chooseFile(electronApp, modelPath);
  const chatModelId = await page.evaluate(async () => {
    const [sourcePath] = await window.nocai.dialog.openFiles({ filters: [{ name: 'GGUF model', extensions: ['gguf'] }] });
    const model = await window.nocai.models.importModel({ sourcePath, role: 'chat', name: 'Workflow local chat fixture', copy: false });
    return model.id;
  });
  expect(fs.existsSync(modelPath), 'Referencing a model must preserve the original model file').toBe(true);
  const embeddingId = await page.evaluate(async () => (await window.nocai.models.listModels('embedding')).find(model => model.status === 'active')?.id);
  expect(Boolean(embeddingId)).toBe(true);

  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: /^(New Collection|Create Collection)$/ }).first().click();
  const createDialog = page.getByRole('dialog', { name: 'Create Collection', exact: true });
  await createDialog.getByLabel('Name', { exact: true }).fill('Synthetic operations runbook');
  await createDialog.getByRole('button', { name: 'Create Collection', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  const collectionId = await page.evaluate(async () => (await window.nocai.knowledge.listCollections()).find(collection => collection.name === 'Synthetic operations runbook')?.id);
  expect(Boolean(collectionId)).toBe(true);

  const snapshots = [];
  const start = Date.now();
  let cycle = 0;
  const metricsPath = testInfo.outputPath('workflow-resource-snapshots.json');
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  const persistMetrics = () => fs.writeFileSync(metricsPath, JSON.stringify({
    minutes, completedCycles: snapshots.length, elapsedMs: Date.now() - start, snapshots,
  }, null, 2));
  persistMetrics();
  do {
    cycle += 1;
    const marker = `SYNTHETIC-CYCLE-${cycle}`;
    const documentPath = path.join(profileDir, `synthetic-runbook-${cycle}.txt`);
    fs.writeFileSync(documentPath, `Synthetic operations runbook ${marker}. The fictional Northstar team owns router maintenance. During maintenance, record an approved change, back up the router configuration, run the canary validation, and close the synthetic incident only after the health checks pass. This document is a generated test fixture and contains no user data.\n`.repeat(3));
    await chooseFile(electronApp, documentPath);
    await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
    await page.getByText('Synthetic operations runbook', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Upload Documents', exact: true }).first().click();
    const upload = page.getByRole('dialog', { name: 'Upload Documents', exact: true });
    await upload.getByRole('button', { name: /Choose documents or drop them here/ }).click();
    await upload.getByRole('button', { name: 'Queue 1 document', exact: true }).click();
    await Promise.race([upload.waitFor({ state: 'hidden' }), upload.getByRole('alert').waitFor({ state: 'visible' })]);
    if (await upload.getByRole('alert').count()) {
      throw new Error(`Synthetic upload rejected: ${(await upload.getByRole('alert').innerText()).replace(/[A-Za-z]:\\[^\r\n"<>]+/g, '[isolated test path]')}`);
    }
    await expect(upload).toHaveCount(0);
    let documentId;
    await expect.poll(async () => page.evaluate(async ({ id, filename }) => {
      const documents = await window.nocai.knowledge.listDocuments(id);
      const document = documents.find(item => item.originalFilename === filename);
      if (!document) return 'missing';
      const jobs = await window.nocai.admin.getJobs({});
      if (!jobs.some(job => job.documentId === document.id)) return 'missing-durable-job';
      return document.status === 'ready' && document.chunkCount > 0 ? 'ready' : document.status;
    }, { id: collectionId, filename: path.basename(documentPath) }), { timeout: 120000, message: 'Upload must produce a durable job and searchable indexed chunks' }).toBe('ready');
    documentId = await page.evaluate(async ({ id, filename }) => (await window.nocai.knowledge.listDocuments(id)).find(item => item.originalFilename === filename).id, { id: collectionId, filename: path.basename(documentPath) });

    const sourceFound = await page.evaluate(async ({ collectionId, documentId }) => {
      const results = await window.nocai.knowledge.search({ query: 'Which team owns router maintenance?', collectionIds: [collectionId], topK: 3 });
      return results.some(result => result.documentId === documentId && result.content.includes('Northstar') && Number.isFinite(result.score));
    }, { collectionId, documentId });
    expect(sourceFound, 'Real BGE retrieval must return the uploaded source and finite relevance').toBe(true);

    // The local fallback fixture is 4B: load it only for chat so ingestion can
    // retain its real memory reserve on smaller Windows development machines.
    await page.evaluate(id => window.nocai.models.activateModel(id, 'chat'), chatModelId);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
    const conversationId = new URL(page.url()).hash.split('/').pop();
    await page.evaluate(async ({ conversationId, chatModelId, collectionId }) => {
      await window.nocai.chat.updateConversation(conversationId, { modelId: chatModelId, collectionId, maxTokens: 128, temperature: 0 });
    }, { conversationId, chatModelId, collectionId });
    // Re-enter through navigation so the visible composer uses saved preferences.
    await page.getByRole('link', { name: 'Chats', exact: true }).click();
    await page.evaluate(id => { window.location.hash = `/chats/${id}`; }, conversationId);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('According to the source, which team owns router maintenance? Answer in one sentence. /no_think');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => page.evaluate(async id => {
      const messages = await window.nocai.chat.getMessages(id);
      return messages.some(message => message.role === 'assistant' && message.content.trim().length > 0 && message.citations?.length > 0);
    }, conversationId), { timeout: 180000, message: 'UI request must persist a nonempty real completion with source citations' }).toBe(true);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
    await page.evaluate(id => window.nocai.models.deactivateModel(id), chatModelId);

    for (const name of ['Models', 'Knowledge', 'Search', 'Settings', 'Diagnostics', 'Chats']) {
      await page.getByRole('link', { name, exact: true }).click();
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByText('This view could not be displayed', { exact: true })).toHaveCount(0);
    }
    await page.evaluate(async () => { await window.nocai.system.restartBackend(); });
    await expect.poll(async () => page.evaluate(async () => (await window.nocai.system.getHealth()).components?.embeddingRuntime?.status), { timeout: 90000 }).toBe('healthy');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await signIn(page, password);
    const survived = await page.evaluate(async id => (await window.nocai.chat.getMessages(id)).some(message => message.role === 'assistant' && message.content.length > 0 && message.citations.length > 0), conversationId);
    expect(survived, 'Conversation and cited completion must survive backend restart').toBe(true);
    await page.evaluate(async ({ conversationId, documentId }) => {
      await window.nocai.chat.deleteConversation(conversationId);
      await window.nocai.knowledge.deleteDocument(documentId);
    }, { conversationId, documentId });
    const members = processMetrics(electronApp.process().pid);
    const snapshot = { cycle, elapsedMs: Date.now() - start, processes: members.length, handles: members.reduce((sum, member) => sum + member.handles, 0), threads: members.reduce((sum, member) => sum + member.threads, 0), rss: members.reduce((sum, member) => sum + member.rss, 0), logBytes: logBytes(path.join(profileDir, 'logs')) + logBytes(path.join(profileDir, 'data/logs')) };
    snapshots.push(snapshot);
    persistMetrics();
    expect(snapshot.processes).toBeLessThanOrEqual(16);
    expect(snapshot.handles).toBeLessThanOrEqual(15000);
    expect(snapshot.threads).toBeLessThanOrEqual(500);
    expect(snapshot.logBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    if (snapshots.length > 2) {
      expect(snapshot.rss - snapshots[1].rss).toBeLessThan(512 * 1024 * 1024);
      expect(snapshot.handles - snapshots[1].handles).toBeLessThan(1000);
    }
  } while (minutes > 0 ? Date.now() - start < minutes * 60000 : cycle < 2);
  await testInfo.attach('workflow-resource-snapshots', { path: metricsPath, contentType: 'application/json' });
});
