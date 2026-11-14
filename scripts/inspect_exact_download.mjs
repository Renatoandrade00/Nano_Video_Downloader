import { chromium } from 'playwright';
import path from 'path';

async function run() {
  const profileDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch/playwright_chrome_profile';
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1366, height: 1000 },
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  page.on('request', req => {
    const u = req.url();
    if (u.includes('drm') || u.includes('attachment') || u.includes('download')) {
      console.log('\n>>> REQUEST:', req.method(), u);
      console.log('Headers:', JSON.stringify(req.headers(), null, 2));
      const postData = req.postData();
      if (postData) console.log('POST Data:', postData);
    }
  });

  page.on('response', res => {
    const u = res.url();
    if (u.includes('drm') || u.includes('attachment') || u.includes('download')) {
      console.log('\n<<< RESPONSE:', res.status(), u);
      console.log('Headers:', JSON.stringify(res.headers(), null, 2));
    }
  });

  page.on('download', dl => {
    console.log('\n🎉 DOWNLOAD EVENT:');
    console.log('Filename:', dl.suggestedFilename());
    console.log('URL:', dl.url());
  });

  console.log('Navigating to lesson...');
  await page.goto('https://hotmart.com/pt-BR/club/mike-school/products/8792144/content/o4EWn8BR7z', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('Current URL:', page.url());
  console.log('Page Title:', await page.title());

  console.log('Closing cookie banner...');
  await page.evaluate(() => {
    const banners = Array.from(document.querySelectorAll('*')).filter(el => /este site utiliza cookies/i.test(el.textContent || '') && el.children.length <= 4);
    for (const b of banners) {
      const c = b.closest('div[style*="fixed"], div[class*="cookie"]') || b.parentElement;
      if (c) c.remove();
    }
    window.scrollBy(0, 700);
  });
  await page.waitForTimeout(1000);

  console.log('Clicking Materiais tab...');
  const matTab = page.locator('button, [role="tab"], div, span, a').filter({ hasText: /^materiais(\s*\d+)?$/i }).first();
  if (await matTab.count() > 0) {
    await matTab.click();
    console.log('Materiais clicked!');
  }

  await page.waitForTimeout(2000);

  console.log('Clicking Download button...');
  const dlBtn = page.locator('button, a').filter({ hasText: /^download$/i }).first();
  if (await dlBtn.count() > 0) {
    console.log('Download button found, clicking...');
    await dlBtn.click();
    await page.waitForTimeout(5000);
  } else {
    console.log('Download button NOT found!');
  }

  await context.close();
}

run().catch(console.error);
