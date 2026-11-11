import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStructuredLessonPath,
  formatCourseFolder,
  formatLessonFileName,
  formatModuleFolder,
  sanitizeSegment,
} from '../src/shared/pathSanitizer';

describe('pathSanitizer (RF-11)', () => {
  it('formats structured path /{Nome_Curso}/{Modulo_XX}/{Aula_YY - Titulo}.mp4', () => {
    const out = buildStructuredLessonPath({
      libraryRootDir: '/tmp/library',
      courseTitle: 'Arquitetura Avançada: Microsserviços',
      moduleOrder: 3,
      lessonOrder: 7,
      lessonTitle: 'Introdução & Padrões?',
    });

    const expected = path.join(
      '/tmp/library',
      'Arquitetura Avançada Microsserviços',
      'Modulo_03',
      'Aula_07 - Introdução & Padrões.mp4',
    );
    expect(out).toBe(expected);
  });

  it('handles Windows reserved names and trailing dots/spaces', () => {
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('lpt1')).toBe('_lpt1');
    expect(sanitizeSegment('Aula Especial...   ')).toBe('Aula Especial');
  });

  it('pads module and lesson indices with 2+ digits', () => {
    expect(formatModuleFolder(1)).toBe('Modulo_01');
    expect(formatModuleFolder(12)).toBe('Modulo_12');
    expect(formatLessonFileName(105, 'Encerramento')).toBe('Aula_105 - Encerramento.mp4');
  });

  it('truncates excessively long lesson titles while keeping .mp4 extension', () => {
    const longTitle = 'A'.repeat(300);
    const result = buildStructuredLessonPath({
      libraryRootDir: 'D:\\Renato\\Videos\\Biblioteca',
      courseTitle: formatCourseFolder('Curso Completo de Engenharia'),
      moduleOrder: 1,
      lessonOrder: 1,
      lessonTitle: longTitle,
    });
    expect(result.endsWith('.mp4')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(245);
  });
});

