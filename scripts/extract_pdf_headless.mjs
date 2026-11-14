import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function run() {
  const scratchDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch';
  const profileDir = path.join(scratchDir, 'playwright_chrome_profile');

  console.log('Iniciando Chromium com o perfil já autenticado...');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true, // Já está autenticado!
    viewport: { width: 1366, height: 1200 }, // Altura maior para ver tudo
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  const apis = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') && (url.includes('hotmart') || url.includes('cb.hotmart') || url.includes('cloudfront'))) {
      try {
        const body = await res.json();
        const text = JSON.stringify(body);
        if (text.includes('.pdf') || text.includes('attachment') || text.includes('material') || url.includes('lesson')) {
          console.log(`\n📥 API com materiais/aula: ${url}`);
          apis.push({ url, body });
          fs.writeFileSync(
            path.join(scratchDir, `api_material_${Date.now()}.json`),
            JSON.stringify({ url, status: res.status(), body }, null, 2),
            'utf8'
          );
        }
      } catch {}
    }
  });

  page.on('download', async (dl) => {
    console.log(`\n🎉🎉🎉 DOWNLOAD CAPTURADO COM SUCESSO!`);
    console.log(`Arquivo: ${dl.suggestedFilename()}`);
    console.log(`URL do arquivo: ${dl.url()}`);
    const dest = path.join(scratchDir, dl.suggestedFilename());
    await dl.saveAs(dest);
    console.log(`Arquivo gravado em: ${dest}`);
  });

  const url = 'https://hotmart.com/pt-BR/club/mike-school/products/8792144/content/o4EWn8BR7z';
  console.log(`Navegando para a aula 02: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

  console.log('Página carregada:', await page.title());

  // 1. Fechar o banner de cookies clicando em "OK"
  console.log('Verificando banner de cookies...');
  const okBtn = page.locator('button').filter({ hasText: /^ok$/i }).first();
  if ((await okBtn.count()) > 0) {
    console.log('Clicando no botão OK de cookies...');
    await okBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Também remover via JS se ainda existir
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter(el => /este site utiliza cookies/i.test(el.textContent || '') && el.children.length <= 4);
    for (const el of els) {
      const container = el.closest('div[style*="fixed"], div[class*="cookie"], div[class*="modal"]') || el.parentElement;
      if (container) container.remove();
    }
  });

  // 2. Fazer scroll para baixo
  console.log('Fazendo scroll para baixo...');
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(2000);

  // 3. Localizar aba "Materiais" ou "Materiais 1"
  console.log('Procurando aba Materiais...');
  const tabLocator = page.locator('button, [role="tab"], div, span, li, a').filter({ hasText: /^materiais(\s*\d+)?$/i }).first();
  if ((await tabLocator.count()) > 0) {
    console.log('Clicando na aba Materiais...');
    await tabLocator.click();
  } else {
    console.log('Tentando clique via querySelector...');
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find(el => {
        const t = (el.textContent || '').trim();
        return /^materiais(\s*\d+)?$/i.test(t) && el.children.length <= 4;
      });
      if (target) target.click();
    });
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(scratchDir, 'playwright_materiais_aberto_sucesso.png') });

  // 4. Inspecionar o card do material
  const materialsInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    
    // Todos os elementos contendo .pdf
    const pdfNodes = all.filter(el => (el.textContent || '').includes('.pdf') && el.children.length <= 4).map(el => ({
      tagName: el.tagName,
      className: el.className,
      text: (el.textContent || '').trim().replace(/\s+/g, ' '),
      html: el.outerHTML,
      parentHtml: el.parentElement ? el.parentElement.outerHTML : '',
    }));

    // Todos os botões Download
    const downloadBtns = Array.from(document.querySelectorAll('button, a')).filter(el => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t === 'download' || t === 'baixar' || el.hasAttribute('download');
    }).map(b => ({
      tag: b.tagName,
      className: b.className,
      text: (b.textContent || '').trim(),
      href: b.getAttribute('href'),
      attrs: Array.from(b.attributes).map(a => `${a.name}="${a.value}"`).join(' '),
      html: b.outerHTML,
    }));

    return {
      pdfNodes,
      downloadBtns,
      pageText: document.body.innerText.slice(0, 3000),
    };
  });

  console.log('\n======================================================');
  console.log('RESULTADO DA EXTRAÇÃO DE MATERIAIS:');
  console.log('PDFs encontrados:', JSON.stringify(materialsInfo.pdfNodes, null, 2));
  console.log('Botões de download:', JSON.stringify(materialsInfo.downloadBtns, null, 2));
  console.log('======================================================\n');

  fs.writeFileSync(
    path.join(scratchDir, 'materiais_extraidos.json'),
    JSON.stringify(materialsInfo, null, 2),
    'utf8'
  );

  // 5. Clicar no botão Download para disparar o download real
  const dl = page.locator('button, a').filter({ hasText: /^download$|^baixar$/i }).first();
  if ((await dl.count()) > 0) {
    console.log('Clicando no botão de Download...');
    try {
      const [downloadEvent] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        dl.click(),
      ]);
      console.log(`>>> DOWNLOAD CONCLUÍDO!`);
      console.log(`Arquivo: ${downloadEvent.suggestedFilename()}`);
      console.log(`URL: ${downloadEvent.url()}`);
      await downloadEvent.saveAs(path.join(scratchDir, downloadEvent.suggestedFilename()));
    } catch (e) {
      console.log('Aviso ao aguardar evento de download:', e.message);
    }
  }

  // 6. Exportar cookies e localStorage finais para o app do Electron
  const sessionState = await context.storageState();
  fs.writeFileSync(
    path.join(scratchDir, 'hotmart_final_session.json'),
    JSON.stringify(sessionState, null, 2),
    'utf8'
  );

  console.log('Concluído com sucesso! Fechando navegador...');
  await context.close();
}

run().catch(e => {
  console.error('Erro na execução:', e);
});
