import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function run() {
  const scratchDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch';
  const profileDir = path.join(scratchDir, 'playwright_chrome_profile');

  console.log('========================================================================');
  console.log('🚀 PLAYWRIGHT INICIADO — TEMPO LIVRE PARA NAVEGAÇÃO');
  console.log('========================================================================');
  console.log('Você tem 4 MINUTOS para:');
  console.log('1. Fazer seu login com calma se necessário.');
  console.log('2. Entrar na Aula 02 do curso (Extensivo CHQAOPM 2027).');
  console.log('3. Clicar na aba "Materiais 1" e no botão "Download".');
  console.log('');
  console.log('👉 Enquanto você navega, o Playwright captura automaticamente:');
  console.log('   - Todas as requisições de API de materiais;');
  console.log('   - A URL e o arquivo baixado;');
  console.log('   - O estado de autenticação para o aplicativo!');
  console.log('========================================================================\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null, // Maximizado na tela
    args: ['--start-maximized'],
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // Interceptar respostas de API relevantes
  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') && (url.includes('hotmart') || url.includes('cloudfront') || url.includes('cb.hotmart'))) {
      try {
        const body = await res.json();
        const text = JSON.stringify(body);
        if (
          text.includes('.pdf') ||
          text.includes('ICP') ||
          text.includes('attachment') ||
          text.includes('material') ||
          url.includes('attachment') ||
          url.includes('material') ||
          url.includes('lesson')
        ) {
          console.log(`\n📥 [API DETECTADA EM TEMPO REAL]`);
          console.log(`URL: ${url}`);
          fs.writeFileSync(
            path.join(scratchDir, `api_live_${Date.now()}.json`),
            JSON.stringify({ url, status: res.status(), body }, null, 2),
            'utf8'
          );
        }
      } catch {}
    }
  });

  // Interceptar eventos de download
  page.on('download', async (dl) => {
    const filename = dl.suggestedFilename();
    const downloadUrl = dl.url();
    console.log(`\n🎉🎉🎉 [EVENTO DE DOWNLOAD CAPTURADO COM SUCESSO!]`);
    console.log(`Nome do Arquivo: ${filename}`);
    console.log(`URL do Arquivo: ${downloadUrl}`);
    const dest = path.join(scratchDir, filename);
    await dl.saveAs(dest);
    console.log(`Arquivo salvo com sucesso em: ${dest}\n`);
  });

  const targetLessonUrl = 'https://hotmart.com/pt-BR/club/mike-school/products/8792144/content/o4EWn8BR7z';
  console.log(`Abrindo a página inicial: ${targetLessonUrl}`);
  await page.goto(targetLessonUrl, { timeout: 60000 }).catch(() => {});

  // Tempo livre de 4 minutos (240 segundos) para o usuário navegar à vontade
  const totalSeconds = 240;
  for (let s = totalSeconds; s > 0; s -= 10) {
    console.log(`⏳ Tempo restante de navegação: ${s} segundos...`);
    await page.waitForTimeout(10000);

    // Salvar screenshot periódica e dados do DOM se estiver na aula
    const currentUrl = page.url();
    if (currentUrl.includes('o4EWn8BR7z')) {
      try {
        const domDump = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const pdfs = all
            .filter((el) => (el.textContent || '').includes('.pdf') && el.children.length <= 3)
            .map((el) => ({
              text: (el.textContent || '').trim().replace(/\s+/g, ' '),
              html: el.outerHTML,
            }));
          const btns = Array.from(document.querySelectorAll('button, a'))
            .filter((b) => {
              const t = (b.textContent || '').trim().toLowerCase();
              return t === 'download' || t === 'baixar';
            })
            .map((b) => ({
              text: (b.textContent || '').trim(),
              href: b.getAttribute('href'),
              html: b.outerHTML,
            }));
          return { pdfs, btns };
        });

        if (domDump.pdfs.length > 0 || domDump.btns.length > 0) {
          fs.writeFileSync(
            path.join(scratchDir, 'live_dom_materials.json'),
            JSON.stringify(domDump, null, 2),
            'utf8'
          );
        }
      } catch {}
    }
  }

  // Salvar sessão final
  const storageState = await context.storageState();
  fs.writeFileSync(
    path.join(scratchDir, 'hotmart_authenticated_session.json'),
    JSON.stringify(storageState, null, 2),
    'utf8'
  );
  console.log('\n💾 Sessão salva com sucesso!');
  console.log('Fechando o navegador...');
  await context.close();
}

run().catch((e) => {
  console.error('Erro:', e);
});
