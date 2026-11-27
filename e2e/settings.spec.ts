import { runCommand, signIn } from './access.js';
import { expect, test } from './test.js';

const SECTIONS = ['Doctor', 'Projects', 'Models & agents', 'Profiles', 'Approvals', 'Workspaces', 'Schedules', 'Phone & remote access', 'Computers', 'Storage & integrations', 'Advanced'];

test('Settings opens from the sidebar gear or the palette and lists the 11 sections; Doctor opens first with the setup checks @phone', async ({ page }, info) => {
  await signIn(page);
  if (info.project.name === 'phone') await runCommand(page, 'Settings');
  else await page.getByRole('complementary', { name: 'hos navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('tab')).toHaveText(SECTIONS.map((title, i) => `${i + 1}${title}`));
  const doctor = page.getByRole('tabpanel', { name: 'Doctor' });
  await expect(doctor.getByText('Checks that hos can run on this computer. Each problem comes with its fix.')).toBeVisible();
  await expect(doctor.getByRole('list', { name: 'Doctor' }).getByRole('listitem', { name: 'Claude login' })).toBeVisible();
  await expect(doctor.getByRole('listitem', { name: 'Brain folder' })).toContainText('my-brain');
  const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(width).toBeLessThanOrEqual(0);
});

test('every section shows its purpose and its rows: models and limits under Models & agents, the Balanced preset in plain words, environment files under Workspaces, notifications under Phone & remote access, data sources and the owner', async ({ page }, info) => {
  await signIn(page);
  await page.goto('/#/settings/agents');
  const panel = (name: string) => page.getByRole('tabpanel', { name });

  const agents = page.getByRole('list', { name: 'Models & agents settings' });
  await expect(agents.getByRole('listitem', { name: 'Haiku 5.5', exact: true })).toContainText('claude-haiku-5-5');
  await expect(agents.getByRole('listitem', { name: 'default', exact: true })).toContainText('claude-opus-5-5');
  await expect(panel('Models & agents').getByRole('link', { name: 'Read the guide' })).toBeVisible();

  await page.getByRole('tab', { name: 'Approvals' }).click();
  const approvals = page.getByRole('list', { name: 'Approvals settings' });
  await expect(approvals.getByRole('listitem', { name: 'Preset' })).toContainText('Ask first');
  await expect(approvals.getByRole('listitem', { name: 'Publish: push, open a pull request, deploy' })).toContainText('Asks every time');
  await expect(approvals.getByRole('listitem', { name: 'Read files and search' })).toContainText('Runs');

  await page.getByRole('tab', { name: 'Workspaces' }).click();
  await expect(panel('Workspaces').getByRole('heading', { name: 'Environment files' })).toBeVisible();

  await page.getByRole('tab', { name: 'Schedules' }).click();
  await expect(page).toHaveURL(/#\/settings\/schedules$/);
  const schedules = panel('Schedules');
  await expect(schedules.getByText(/Times are \S+ \(\S+\)\.$/)).toBeVisible();
  await expect(schedules.getByText('No schedules yet.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask to change a setting' })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Phone & remote access' }).click();
  const remote = panel('Phone & remote access');
  await expect(remote.getByText(/^This device only/)).toBeVisible();
  const kinds = remote.getByRole('list', { name: 'Notification kinds' });
  await expect(kinds.getByRole('listitem')).toHaveCount(8);
  await expect(kinds.getByRole('listitem', { name: 'Approval needed' })).toContainText('when a chat asks before running a tool');
  await expect(remote.getByRole('listitem', { name: 'How you reach this computer' })).toBeVisible();

  await page.getByRole('tab', { name: 'Storage & integrations' }).click();
  const storage = page.getByRole('list', { name: 'Storage & integrations settings' });
  await expect(storage.getByRole('listitem', { name: 'Snags', exact: true })).toContainText('This computer');
  await expect(storage.getByRole('listitem', { name: 'Calendar', exact: true })).toContainText('none');

  await page.getByRole('tab', { name: 'Advanced' }).click();
  const advanced = page.getByRole('list', { name: 'Advanced settings' });
  await expect(advanced.getByRole('listitem', { name: 'Your name' })).toContainText('not set');
  await expect(advanced.getByRole('listitem', { name: 'Time zone' })).toBeVisible();
  await expect(advanced.getByRole('listitem', { name: 'Keep reasoning traces for' })).toContainText('forever');

  await page.goto('/#/settings/config');
  await expect(page).toHaveURL(/#\/settings\/workspaces$/);
  await expect(page.getByRole('tab', { name: 'Workspaces' })).toHaveAttribute('aria-selected', 'true');

  for (const [i, title] of SECTIONS.entries()) {
    await page.getByRole('tab', { name: title }).click();
    await expect(page.getByRole('tabpanel', { name: title }).getByRole('heading', { level: 2, name: title })).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: info.outputPath(`settings-${String(i + 1).padStart(2, '0')}-${title.replace(/\W+/g, '-').toLowerCase()}.png`), fullPage: true });
  }
});
