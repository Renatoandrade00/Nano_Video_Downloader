import { app, BrowserWindow, session } from 'electron';

export function enableOfflineE2ECheck(mainWindow: BrowserWindow): void {
  // Block all outbound HTTP/HTTPS requests to simulate Airplane Mode inside Electron
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => {
      callback({ cancel: true });
    },
  );

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      mainWindow.webContents.send('network:statusChanged', { online: false });
      // Allow React initial effects to settle
      await new Promise((r) => setTimeout(r, 400));

      const report = (await mainWindow.webContents.executeJavaScript(
        `(async () => {
          const offline = await window.antigravity.catalog.getOffline();
          if (!offline.length || !offline[0].modules.length || !offline[0].modules[0].lessons.length) {
            throw new Error('Offline catalog did not load from SQLite.');
          }
          const lesson = offline[0].modules[0].lessons[0];
          const bodyText = document.body.innerText || '';
          if (!bodyText.includes(lesson.title)) {
            throw new Error('Rendered UI missing offline lesson title: ' + lesson.title);
          }

          const opened = await window.antigravity.player.openLesson(lesson.id);
          const rangeRes = await fetch(opened.fileUrl, {
            headers: { Range: 'bytes=0-511' },
          });
          if (rangeRes.status !== 206) {
            throw new Error('Expected 206 Partial Content from antigravity-media://, got ' + rangeRes.status);
          }
          const buf = new Uint8Array(await rangeRes.arrayBuffer());
          if (buf.byteLength === 0) {
            throw new Error('Empty byte-range response for local MP4.');
          }

          // Click "Assistir" button and verify native <video> loads local file metadata
          const watchBtn = Array.from(document.querySelectorAll('button')).find((b) =>
            (b.textContent || '').includes('Assistir'),
          );
          if (!watchBtn) {
            throw new Error('Assistir button not found in Offline Library UI.');
          }
          watchBtn.click();

          const videoDuration = await new Promise((resolve, reject) => {
            const deadline = Date.now() + 5000;
            const poll = () => {
              const vid = document.querySelector('video');
              if (vid && vid.readyState >= 1 && vid.duration > 0) {
                resolve(vid.duration);
                return;
              }
              if (Date.now() > deadline) {
                reject(new Error('Timed out waiting for <video> loadedmetadata in Electron.'));
                return;
              }
              setTimeout(poll, 50);
            };
            poll();
          });

          const saved = await window.antigravity.player.saveProgress(lesson.id, 550, 1.75);
          if (!saved.isWatched) {
            throw new Error('Expected isWatched=true at >=90% duration.');
          }

          const refreshed = await window.antigravity.catalog.getOffline();
          const refreshedLesson = refreshed[0].modules[0].lessons[0];
          return {
            courseCount: refreshed.length,
            lessonTitle: refreshedLesson.title,
            rangeStatus: rangeRes.status,
            rangeBytes: buf.byteLength,
            videoDuration,
            isWatched: refreshedLesson.progress?.isWatched ?? false,
            playbackSpeed: refreshedLesson.progress?.playbackSpeed ?? 1.0,
          };
        })()`,
        true,
      )) as Record<string, unknown>;

      console.log(`NANO_E2E_RESULT:${JSON.stringify(report)}`);
      app.exit(0);
    } catch (err) {
      console.error('NANO_E2E_ERROR:', err instanceof Error ? err.message : String(err));
      app.exit(1);
    }
  });
}

