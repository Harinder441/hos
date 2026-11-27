import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from './access.js';
import { api, newTopic, tempGitRepo, topicHash } from './fixtures.js';
import { expect, test } from './test.js';

const COLORS = { generic: '#8b95a5', lead: '#d9a441', engineer: '#4f9fd9', product: '#a37fdb', learner: '#5fb878', life: '#d97a9b', settings: '#c8875a' };

test("each chat's tab is tinted with its profile colour, its composer border is that colour, and / lists only the profile's skills", async ({ page }, info) => {
  const dirs = Object.entries(COLORS).map(([id, color]) => {
    const dir = join(process.env.HOS_E2E_BRAIN!, 'profiles', id);
    mkdirSync(dir, { recursive: true });
    const skills = id === 'life' ? 'skills: [tldr]\n' : id === 'engineer' ? 'skills: [work-in]\n' : '';
    writeFileSync(join(dir, 'PROFILE.md'), `---\ndescription: ${id}\n${skills}color: '${color}'\n---\n`);
    return dir;
  });
  try {
    const { topicId, chatId } = await newTopic({ title: `colours-${info.project.name}`, repo: tempGitRepo() });
    const client = await api();
    const chats: Record<string, string> = { generic: chatId };
    for (const id of Object.keys(COLORS).filter((p) => p !== 'generic')) chats[id] = (await client.addTopicChat(topicId, { profile: id })).id;
    await client.sendMessage(chats.engineer!,'A deliberately long first line so this tab title has to ellipsize');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1700, height: 800 });
    await signIn(page);
    await page.goto(topicHash(topicId, chats.life));
    const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
    await expect(tabs.getByRole('tab')).toHaveCount(7);
    await expect(tabs.getByRole('tab', { name: /A deliberately long/ })).toBeVisible();
    const widths = await page.locator('.ctabs > .ctab:has(a[role="tab"])').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(widths).toEqual(Array(7).fill(200));
    const pane = page.getByRole('main');
    const composer = pane.getByRole('form', { name: 'Composer' });
    const border = (hex: string) =>
      page.evaluate((hex) => {
        const probe = document.body.appendChild(document.createElement('div'));
        probe.style.color = `color-mix(in srgb, ${hex} 70%, #22272b)`;
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }, hex);
    const lifeBorder = await border(COLORS.life);
    await expect(composer).toHaveCSS('border-top-color', lifeBorder);
    await expect(page.locator('.ctab.profiled[aria-current="page"]')).toHaveCSS('border-top-color', lifeBorder);

    const skills = pane.getByRole('listbox', { name: 'Skills' });
    await pane.getByLabel('Message').fill('/');
    await expect(skills.getByRole('option')).toHaveText([/\/restart/, /\/tldr/]);
    await page.locator('.chat-tabs').screenshot({ path: info.outputPath(`profile-tabs-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });
    await composer.screenshot({ path: info.outputPath(`profile-composer-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });
    await page.locator('.ctabs').evaluate((nav) => nav.scrollTo({ left: nav.scrollWidth }));
    await page.locator('.chat-tabs').screenshot({ path: info.outputPath(`profile-tabs-end-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });

    await page.goto(topicHash(topicId, chats.engineer));
    await expect(composer).toHaveCSS('border-top-color', await border(COLORS.engineer));
    await pane.getByLabel('Message').fill('/');
    await expect(skills.getByRole('option')).toHaveText([/\/restart/, /\/work-in/]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.ctab[aria-current="page"]')).toHaveCSS('width', '200px');
    await page.screenshot({ path: info.outputPath(`profile-phone-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });
    await expect(page.locator('.chat-tabs')).toBeVisible();
    await page.locator('.chat-tabs').screenshot({ path: info.outputPath(`profile-tabs-phone-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('the new-chat profile picker hides spawn-only profiles, turns the Browser on for a browser profile, and remembers the last profile used in the topic', async ({ page }, info) => {
  const write = (id: string, extra: string) => {
    const dir = join(process.env.HOS_E2E_BRAIN!, 'profiles', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROFILE.md'), `---\ndescription: ${id}\n${extra}---\n`);
    return dir;
  };
  const dirs = [write('remember-e2e', ''), write('browser-e2e', 'browser: true\n'), write('hidden-e2e', 'picker: false\n')];
  try {
    const { topicId } = await newTopic({ title: `remember-${info.project.name}`, repo: tempGitRepo() });
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page);
    await page.goto(topicHash(topicId));
    const pane = page.getByRole('main');
    const composer = pane.getByRole('form', { name: 'Composer' });
    const chip = composer.getByRole('button', { name: /^Profile: / });
    const fresh = async () => {
      await page.getByRole('button', { name: 'New chat in this topic' }).click();
      await expect(chip).toBeVisible();
    };

    await fresh();
    await expect(chip).toHaveAccessibleName('Profile: generic');
    await chip.click();
    await expect(composer.getByRole('menuitemradio', { name: 'remember-e2e' })).toBeVisible();
    await expect(composer.getByRole('menuitemradio', { name: 'hidden-e2e' })).toHaveCount(0);
    const browser = composer.getByRole('button', { name: 'Browser', exact: true });
    await composer.getByRole('menuitemradio', { name: 'browser-e2e' }).click();
    await expect(browser).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await composer.getByRole('menuitemradio', { name: 'remember-e2e' }).click();
    await expect(browser).toHaveAttribute('aria-pressed', 'false');
    await pane.getByLabel('Message').fill('remember this profile');
    await pane.getByRole('button', { name: 'Send' }).click();
    await expect(pane.getByText('Echo: remember this profile', { exact: true })).toBeVisible();

    await fresh();
    await expect(chip).toHaveAccessibleName('Profile: remember-e2e');
    await composer.screenshot({ path: info.outputPath(`profile-remembered-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("picking a profile for a new chat shows that profile's default model and effort, and the chat starts on them", async ({ page }, info) => {
  const dir = join(process.env.HOS_E2E_BRAIN!, 'profiles', 'defaults-e2e');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PROFILE.md'), '---\ndescription: has defaults\nmodels:\n  scripted: { model: claude-sonnet-5-5, effort: medium }\n---\n');
  try {
    const { topicId } = await newTopic({ title: `defaults-${info.project.name}`, repo: tempGitRepo() });
    await page.emulateMedia({ colorScheme: 'dark' });
    await signIn(page);
    await page.goto(topicHash(topicId));
    await page.getByRole('button', { name: 'New chat in this topic' }).click();
    const composer = page.getByRole('main').getByRole('form', { name: 'Composer' });
    await expect(composer.getByRole('button', { name: 'Model: Opus 5.5, effort high' })).toBeVisible();

    await composer.getByRole('button', { name: /^Profile: / }).click();
    await composer.getByRole('menuitemradio', { name: 'defaults-e2e' }).click();
    await expect(composer.getByRole('button', { name: 'Model: Sonnet 5.5, effort medium' })).toBeVisible();
    await composer.screenshot({ path: info.outputPath(`profile-defaults-${info.project.name}.jpeg`), type: 'jpeg', quality: 90 });

    await page.getByRole('main').getByLabel('Message').fill('start on the defaults');
    await page.getByRole('main').getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('main').getByText('Echo: start on the defaults', { exact: true })).toBeVisible();
    const chats = Object.values((await (await api()).snapshot()).state.chats).filter((c) => c.topicId === topicId && c.profile === 'defaults-e2e');
    expect(chats.map((c) => [c.model, c.effort])).toEqual([['claude-sonnet-5-5', 'medium']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typing / lists every skill with its description, filters as you type, and Enter inserts /name to send as is', async ({ page }, info) => {
  const { topicId } = await newTopic({ title: `slash-${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = page.getByRole('main');
  const box = pane.getByLabel('Message');
  const skills = pane.getByRole('listbox', { name: 'Skills' });

  await box.fill('/');
  await expect(skills.getByRole('option')).toHaveCount(3);
  await expect(skills.getByRole('option').first()).toContainText('/restart');
  await expect(skills.getByRole('option', { name: /\/tldr/ })).toContainText('Compress anything into ten lines or fewer.');
  await expect(skills.getByRole('option', { name: /\/work-in/ })).toContainText('Work on a folder that is not the brain.');
  await page.screenshot({ path: info.outputPath(`slash-${info.project.name}.png`) });

  await box.press('Escape');
  await expect(skills).toHaveCount(0);
  await box.fill('/w');
  await expect(skills.getByRole('option')).toHaveText([/\/work-in/]);
  await box.fill('/');
  await box.press('ArrowDown');
  await box.press('ArrowDown');
  await expect(skills.getByRole('option', { name: /\/work-in/ })).toHaveAttribute('aria-selected', 'true');
  await box.press('Enter');
  await expect(box).toHaveValue('/work-in ');
  await expect(skills).toHaveCount(0);

  await box.pressSequentially('the capture app');
  await box.press('Enter');
  await expect(pane.getByText('Echo: /work-in the capture app', { exact: true })).toBeVisible();
});

test('the chat tabs always show; + opens a new empty chat in the same topic whose messages reach it, and × closes its tab', async ({ page }, info) => {
  const title = `tabs-${info.project.name}`;
  const { topicId } = await newTopic({ title, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(topicId));
  const pane = page.getByRole('main');
  const tabs = page.getByRole('tablist', { name: 'Chats in this topic' });
  await expect(tabs.getByRole('tab')).toHaveText(['New chat']);

  await pane.getByLabel('Message').fill('First chat');
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect(pane.getByText('Echo: First chat', { exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveText(['First chat']);

  await page.getByRole('button', { name: 'New chat in this topic' }).click();
  await expect(tabs.getByRole('tab')).toHaveText(['First chat', 'New chat']);
  await expect(tabs.getByRole('tab', { name: /New chat/ })).toHaveAttribute('aria-selected', 'true');
  await expect(pane.getByLabel('Message')).toHaveValue('');
  await expect(pane.getByText('Echo: First chat', { exact: true })).toHaveCount(0);
  await expect(pane.getByRole('form', { name: 'Composer' }).getByRole('button', { name: 'Model: Opus 5.5' })).toBeVisible();

  await pane.getByLabel('Message').fill('in the second chat, name it Second Chat Tab');
  await pane.getByRole('button', { name: 'Send' }).click();
  await expect(tabs.getByRole('status', { name: 'Naming…' })).toBeVisible();
  await expect(pane.getByText('Echo: in the second chat, name it Second Chat Tab', { exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveText(['First chat', 'Second Chat Tab']);
  await page.screenshot({ path: info.outputPath(`tabs-${info.project.name}.png`) });

  await tabs.getByRole('tab', { name: 'First chat' }).click();
  await expect(pane.getByText('Echo: First chat', { exact: true })).toBeVisible();
  await expect(pane.getByText('Echo: in the second chat, name it Second Chat Tab', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Close Second Chat Tab' }).click();
  await expect(tabs.getByRole('tab')).toHaveText(['First chat']);
  await page.reload();
  await expect(page.getByRole('tablist', { name: 'Chats in this topic' }).getByRole('tab')).toHaveText(['First chat']);
});

test('a draft (text and attached files) stays with its chat across topic switches and reloads, and sending clears it; the New chat page keeps its text too', async ({ page }, info) => {
  const first = await newTopic({ title: `draft-a-${info.project.name}`, repo: tempGitRepo() });
  const second = await newTopic({ title: `draft-b-${info.project.name}`, repo: tempGitRepo() });
  await signIn(page);
  await page.goto(topicHash(first.topicId));
  const pane = page.getByRole('main');
  const composer = pane.getByRole('form', { name: 'Composer' });
  const pending = composer.locator('.thread-pending');

  await pane.getByLabel('Message').fill('a long prompt\nwith a second line');
  await composer.evaluate((form) => {
    const data = new DataTransfer();
    data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
  });
  await expect(pending.locator('.thread-att')).toHaveAttribute('title', /^\.context\/topics\//);

  await page.goto(topicHash(second.topicId));
  await expect(page.getByRole('main').getByLabel('Message')).toHaveValue('');
  await page.goto(topicHash(first.topicId));
  await expect(page.getByRole('main').getByLabel('Message')).toHaveValue('a long prompt\nwith a second line');
  await expect(page.getByRole('main').locator('.thread-pending').getByText('notes.txt')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('main').getByLabel('Message')).toHaveValue('a long prompt\nwith a second line');
  await expect(page.getByRole('main').locator('.thread-pending').getByText('notes.txt')).toBeVisible();
  await page.screenshot({ path: info.outputPath(`draft-${info.project.name}.png`) });

  await page.getByRole('main').getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('main').getByText('Echo: a long prompt', { exact: false })).toBeVisible();
  await expect(page.getByRole('main').getByLabel('Message')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('main').getByLabel('Message')).toHaveValue('');
  await expect(page.getByRole('main').locator('.thread-pending')).toHaveCount(0);

  await page.goto('#/new');
  await page.getByLabel('Prompt for the new topic').fill('start something new');
  await page.goto(topicHash(second.topicId));
  await page.goto('#/new');
  await expect(page.getByLabel('Prompt for the new topic')).toHaveValue('start something new');
});
