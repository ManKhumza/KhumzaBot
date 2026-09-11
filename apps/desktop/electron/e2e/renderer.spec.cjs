const { randomBytes } = require('node:crypto');
const { test, expect } = require('./fixtures.cjs');

async function createAdministrator(page) {
  const password = `${randomBytes(20).toString('hex')}Aa!`;
  await expect(page.getByText('Create your administrator', { exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('renderer-admin');
  await page.getByLabel('Administrator password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  return password;
}

test('signed-out UI has no workspace navigation; navigation stays in one application shell', async ({ page }) => {
  await expect(page.getByText('Create your administrator', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0);
  await createAdministrator(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  for (const [name, route] of [['Chats', '/chats'], ['Models', '/models'], ['Knowledge', '/knowledge'], ['Search', '/search'], ['Settings', '/settings'], ['Diagnostics', '/diagnostics']]) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#${route}$`));
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByText('This view could not be displayed', { exact: true })).toHaveCount(0);
  }
});

test('wrong password preserves username and displays a readable error in the sign-in form', async ({ page }) => {
  await createAdministrator(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('renderer-admin');
  await page.getByLabel('Password', { exact: true }).fill(randomBytes(24).toString('hex'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('renderer-admin');
  const alert = page.locator('form').getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('Error invoking remote method');
  await expect(alert).not.toContainText('{"detail"');
});

test('unsent chat draft survives navigation without a loaded chat model', async ({ page }) => {
  await createAdministrator(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(message).toBeEnabled();
  const conversationUrl = page.url();
  const draft = 'Investigate this synthetic incident when the local model is available.';
  await message.fill(draft);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await page.goto(conversationUrl);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
});

test('required password change remains usable when ordinary settings access is restricted', async ({ page }) => {
  await createAdministrator(page);
  const temporaryPassword = `${randomBytes(20).toString('hex')}Aa!`;
  await page.evaluate(async (password) => {
    await window.nocai.admin.createUser({ username: 'change-required', password, roles: ['operator'] });
  }, temporaryPassword);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('change-required');
  await page.getByLabel('Password', { exact: true }).fill(temporaryPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Set a new password', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Chats', exact: true })).toHaveCount(0);
  await page.getByLabel('Current Password', { exact: true }).fill(temporaryPassword);
  const replacement = `${randomBytes(20).toString('hex')}Aa!`;
  await page.getByLabel('New Password', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm New Password', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Change Password', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Chats', exact: true })).toBeVisible();
  await expect(page.getByText('Set a new password', { exact: true })).toHaveCount(0);
});

test('restore cannot be submitted until the replacement warning is acknowledged', async ({ page, electronApp, profileDir }) => {
  await createAdministrator(page);
  // Replace only the OS chooser; the application confirmation and API remain real.
  await electronApp.evaluate(({ dialog }, profile) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [`${profile}/synthetic-backup.zip`] });
  }, profileDir);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Storage', exact: true }).click();
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Restore application backup' });
  await expect(confirmation).toBeVisible();
  const restore = confirmation.getByRole('button', { name: 'Restore and restart', exact: true });
  await expect(restore).toBeDisabled();
  await confirmation.getByRole('checkbox').check();
  await expect(restore).toBeEnabled();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
});
