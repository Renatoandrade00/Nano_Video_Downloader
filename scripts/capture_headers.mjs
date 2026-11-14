import { chromium } from 'playwright';
import path from 'path';

async function run() {
  const scratchDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch';
  const profileDir = path.join(scratchDir, 'playwright_chrome_profile');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  page.on('request', (req) => {
    if (req.url().includes('complementary-content') || req.url().includes('/v2/web/lessons/')) {
      console.log('\n--- REQUEST HEADERS FOR:', req.url(), '---');
      console.log(JSON.stringify(req.headers(), null, 2));
    }
  });

  await page.goto('https://hotmart.com/pt-BR/club/mike-school/products/8792144/content/o4EWn8BR7z', {
    waitUntil: 'networkidle',
  });

  // Clicar em Materiais para disparar o complementary-content
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e => /materiais/i.test((e.textContent || '').trim()) && e.children.length <= 3);
    if (el) el.click();
  });

  await page.waitForTimeout(3000);
  await context.close();
}

run().catch(console.error);
