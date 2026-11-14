import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function run() {
  const scratchDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch';
  const profileDir = path.join(scratchDir, 'playwright_chrome_profile');

  console.log('========================================================================');
  console.log('🚀 INICIANDO PLAYWRIGHT COM GOOGLE CHROME (JANELA VISÍVEL)');
  console.log('========================================================================');
  console.log('Instruções:');
  console.log('1. A janela do Google Chrome vai abrir na sua tela.');
  console.log('2. Caso apareça a tela de Login da Hotmart, faça o login normalmente.');
  console.log('3. Assim que você entrar na aula 02, o script detectará automaticamente');
  console.log('   e fará a inspeção da aba Materiais e o download do PDF.');
  console.log('========================================================================\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 768 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  const allCapturedResponses = [];

  page.on('response', async (res) => {
    const url = res.url();
    const contentType = res.headers()['content-type'] || '';
    if (
      contentType.includes('json') &&
      (url.includes('hotmart') || url.includes('club') || url.includes('cp.hotmart') || url.includes('cloudfront'))
    ) {
      try {
        const body = await res.json();
        const text = JSON.stringify(body);
        if (
          text.includes('.pdf') ||
          text.includes('attachment') ||
          text.includes('material') ||
          text.includes('o4EWn8BR7z') ||
          url.includes('content') ||
          url.includes('lesson')
        ) {
          console.log(`\n📥 [API DETECTADA] ${url}`);
          allCapturedResponses.push({ url, status: res.status(), body });
          fs.writeFileSync(
            path.join(scratchDir, `api_lesson_${Date.now()}.json`),
            JSON.stringify({ url, status: res.status(), body }, null, 2),
            'utf8'
          );
        }
      } catch {}
    }
  });

  page.on('download', async (dl) => {
    const filename = dl.suggestedFilename();
    const downloadUrl = dl.url();
    console.log(`\n🎉 [EVENTO DE DOWNLOAD CAPTURADO COM SUCESSO!]`);
    console.log(`Nome do arquivo: ${filename}`);
    console.log(`URL de download: ${downloadUrl}`);
    const targetFile = path.join(scratchDir, filename);
    await dl.saveAs(targetFile);
    console.log(`Arquivo salvo em: ${targetFile}`);
  });

  const targetLessonUrl = 'https://hotmart.com/pt-BR/club/mike-school/products/8792144/content/o4EWn8BR7z';
  console.log(`Navegando para: ${targetLessonUrl}`);
  await page.goto(targetLessonUrl, { timeout: 60000 }).catch((e) => {
    console.log('Nota ao navegar:', e.message);
  });

  // Aguardar até 10 minutos pelo login do usuário e carregamento da aula
  const maxWaitMs = 10 * 60 * 1000;
  const startTime = Date.now();
  let inLesson = false;

  console.log('\n⏳ Aguardando você acessar a aula 02 no navegador...');
  while (Date.now() - startTime < maxWaitMs) {
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');

    if (
      currentUrl.includes('o4EWn8BR7z') &&
      !currentUrl.includes('sso.hotmart.com/login') &&
      !title.toLowerCase().includes('login')
    ) {
      inLesson = true;
      console.log(`\n✅ Detectado! Aula 02 carregada com sucesso!`);
      console.log(`URL: ${currentUrl}`);
      console.log(`Título: ${title}`);
      break;
    }

    await page.waitForTimeout(3000);
  }

  if (!inLesson) {
    console.log('\n❌ Tempo limite de 10 minutos excedido aguardando o login na aula.');
    await context.close();
    return;
  }

  // Esperar o React montar os componentes da aula
  console.log('\nAguardando a interface terminar a renderização...');
  await page.waitForTimeout(5000);

  // Tirar screenshot inicial
  await page.screenshot({ path: path.join(scratchDir, 'step1_aula_carregada.png') });

  // 1. Procurar e clicar na aba "Materiais"
  console.log('\nProcurando a aba "Materiais"...');
  const matTab = page.locator('button, [role="tab"], div, span').filter({ hasText: /^materiais/i }).first();
  const matExists = (await matTab.count()) > 0;
  console.log(`Aba Materiais encontrada via seletor? ${matExists}`);

  if (matExists) {
    console.log('Clicando na aba Materiais...');
    await matTab.click();
  } else {
    console.log('Tentando clique via evaluate...');
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, [role="tab"], a, div, span, p, li'));
      const target = all.find((el) => {
        const t = (el.textContent || '').trim();
        return /^materiais(\s*\(\d+\)|\s*\d+)?$/i.test(t) && el.children.length <= 4;
      });
      if (target) target.click();
    });
  }

  // Aguardar 4 segundos após o clique para carregar o card de materiais
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(scratchDir, 'step2_materiais_aberto.png') });

  // 2. Extrair dados do DOM
  const domResult = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));

    // Cards contendo .pdf
    const pdfElements = all
      .filter((el) => {
        const t = el.textContent || '';
        return t.includes('.pdf') && el.children.length <= 3;
      })
      .map((el) => ({
        tag: el.tagName,
        className: el.className,
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        html: el.outerHTML,
        parentHtml: el.parentElement ? el.parentElement.outerHTML : '',
      }));

    // Botões de download
    const buttons = Array.from(document.querySelectorAll('button, a'))
      .filter((el) => {
        const t = (el.textContent || '').trim().toLowerCase();
        return t.includes('download') || t.includes('baixar') || el.hasAttribute('download');
      })
      .map((b) => ({
        tag: b.tagName,
        className: b.className,
        text: (b.textContent || '').trim(),
        href: b.getAttribute('href'),
        attributes: Array.from(b.attributes).map((a) => `${a.name}="${a.value}"`).join(' '),
        html: b.outerHTML,
      }));

    return {
      title: document.title,
      url: window.location.href,
      pdfElements,
      buttons,
    };
  });

  console.log('\n========================================================================');
  console.log('📄 ELEMENTOS PDF ENCONTRADOS:');
  console.log(JSON.stringify(domResult.pdfElements, null, 2));
  console.log('\n🔘 BOTÕES DE DOWNLOAD ENCONTRADOS:');
  console.log(JSON.stringify(domResult.buttons, null, 2));
  console.log('========================================================================');

  fs.writeFileSync(
    path.join(scratchDir, 'dom_inspection_result.json'),
    JSON.stringify(domResult, null, 2),
    'utf8'
  );

  // 3. Clicar no botão Download e interceptar o download
  const dlButton = page.locator('button, a').filter({ hasText: /^download$|^baixar$/i }).first();
  if ((await dlButton.count()) > 0) {
    console.log('\n👇 Clicando no botão Download do material...');
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        dlButton.click(),
      ]);
      console.log(`>>> SUCESSO ABSOLUTO! Download interceptado: ${download.suggestedFilename()}`);
      console.log(`>>> URL DIRETA DO PDF: ${download.url()}`);
      await download.saveAs(path.join(scratchDir, download.suggestedFilename()));
    } catch (e) {
      console.log('Aviso ao aguardar evento de download:', e.message);
    }
  }

  // 4. Salvar estado de autenticação para importar no app
  const sessionState = await context.storageState();
  fs.writeFileSync(
    path.join(scratchDir, 'hotmart_authenticated_session.json'),
    JSON.stringify(sessionState, null, 2),
    'utf8'
  );
  console.log('\n💾 Sessão autenticada salva em scratch/hotmart_authenticated_session.json!');

  await page.screenshot({ path: path.join(scratchDir, 'step3_final.png') });
  console.log('\nInspeção concluída! Fechando o navegador em 10 segundos...');
  await page.waitForTimeout(10000);
  await context.close();
}

run().catch((e) => {
  console.error('Erro na execução:', e);
});
