import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

describe('Public Reading Path Smoke Test', () => {
  let browser;
  let page;
  let context;

  before(async () => {
    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    let res = await fetch(`${BASE}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: PW,
        blog_title: 'E2E Blog',
        author_name: 'E2E User',
        email: 'e2e@example.com'
      })
    });
    // 409 means an owner already exists — another e2e file in this run got
    // there first. That is the state this test needs, not a failure.
    if (!res.ok && res.status !== 409) throw new Error('Setup failed: ' + res.status);

    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'the_owner', name: PW })
    });
    let setCookieStr = res.headers.get('set-cookie');
    let cookie = '';
    if (setCookieStr) {
       let match = setCookieStr.match(/session=([^;]+)/);
       if (match) cookie = 'session=' + match[1];
    }
    
    res = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Cookie': cookie 
      },
      body: JSON.stringify({
        title: 'Hello E2E',
        content: 'This is body text. #e2etag',
        excerpt: 'Card text.',
        status: 'published',
        tags: ['e2etag']
      })
    });
    if (!res.ok) throw new Error('Post creation failed: ' + await res.text());
  });

  after(async () => {
    await browser?.close();
  });

  it('home renders posts', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.post-card');
    const text = await page.textContent('.post-card');
    assert.match(text, /Hello E2E/);
  });

  it('a tag page filters', async () => {
    await page.goto(`${BASE}/tags/e2etag`);
    await page.waitForSelector('.post-card');
    const text = await page.textContent('.post-card');
    assert.match(text, /Hello E2E/);
    const title = await page.title();
    assert.match(title, /e2etag/i);
  });

  it('a post opens', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.post-card');
    await page.click('.post-card');
    await page.waitForSelector('.post-content');
    const content = await page.textContent('.post-content');
    assert.match(content, /This is body text/);
  });

  it('immersive opens and closes', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.post-card');
    await page.click('.post-card');
    await page.waitForSelector('.post-content');

    await page.waitForSelector('.immersive-toggle-btn');
    await page.click('.immersive-toggle-btn');
    
    await page.waitForFunction(() => window.location.hash === '#1');

    await page.goBack();
    await page.waitForFunction(() => window.location.hash === '');
  });

  it('admin login', async () => {
    await context.clearCookies();
    await page.goto(`${BASE}/light/login`);
    await page.waitForSelector('#password-input');
    await page.fill('#password-input', 'devpassword');
    await page.press('#password-input', 'Enter');
    
    await page.waitForSelector('.dashboard-grid');
    const text = await page.textContent('body');
    assert.match(text, /Dashboard/i);
  });
});
