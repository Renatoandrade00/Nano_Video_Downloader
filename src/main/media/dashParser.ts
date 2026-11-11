import { XMLParser } from 'fast-xml-parser';

export interface DashSegment {
  index: number;
  uri: string;
  initUri?: string;
}

export interface DashRepresentation {
  id: string;
  mediaType: 'video' | 'audio';
  bandwidth: number;
  height: number;
  segments: DashSegment[];
}

export interface ParsedDashManifest {
  videoRepresentations: DashRepresentation[];
  audioRepresentations: DashRepresentation[];
}

function asArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function resolveUrl(baseUrl: string, rel: string): string {
  try {
    return new URL(rel, baseUrl).toString();
  } catch {
    return rel;
  }
}

export function parseDashManifest(xmlContent: string, mpdUrl: string): ParsedDashManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const doc = parser.parse(xmlContent) as Record<string, unknown>;
  const mpd = doc.MPD as Record<string, unknown> | undefined;
  if (!mpd) {
    throw new Error('Invalid DASH MPD manifest: missing MPD root.');
  }

  const mpdBase = typeof mpd.BaseURL === 'string' ? resolveUrl(mpdUrl, mpd.BaseURL) : mpdUrl;
  const periods = asArray(mpd.Period as Record<string, unknown> | Array<Record<string, unknown>>);

  const videoRepresentations: DashRepresentation[] = [];
  const audioRepresentations: DashRepresentation[] = [];

  for (const period of periods) {
    const periodBase =
      typeof period.BaseURL === 'string' ? resolveUrl(mpdBase, period.BaseURL) : mpdBase;
    const adaptationSets = asArray(
      period.AdaptationSet as Record<string, unknown> | Array<Record<string, unknown>>,
    );

    for (const aset of adaptationSets) {
      const contentType = String(aset['@_contentType'] ?? aset['@_mimeType'] ?? '');
      const isAudio = contentType.includes('audio');
      const mediaType: 'video' | 'audio' = isAudio ? 'audio' : 'video';
      const asetTemplate = aset.SegmentTemplate as Record<string, unknown> | undefined;
      const reps = asArray(
        aset.Representation as Record<string, unknown> | Array<Record<string, unknown>>,
      );

      for (const rep of reps) {
        const repId = String(rep['@_id'] ?? '0');
        const bandwidth = Number(rep['@_bandwidth'] ?? 0);
        const height = Number(rep['@_height'] ?? aset['@_height'] ?? 0);
        const repBase =
          typeof rep.BaseURL === 'string' ? resolveUrl(periodBase, rep.BaseURL) : periodBase;

        const template = (rep.SegmentTemplate as Record<string, unknown> | undefined) ?? asetTemplate;
        const segmentList = rep.SegmentList as Record<string, unknown> | undefined;
        const segments: DashSegment[] = [];

        if (template) {
          const mediaPattern = String(template['@_media'] ?? '');
          const initPattern = template['@_initialization']
            ? String(template['@_initialization'])
            : undefined;
          const startNumber = Number(template['@_startNumber'] ?? 1);
          const initUri = initPattern
            ? resolveUrl(repBase, initPattern.replace(/\$RepresentationID\$/g, repId))
            : undefined;

          const timeline = template.SegmentTimeline as Record<string, unknown> | undefined;
          let count = 0;
          if (timeline) {
            const entries = asArray(timeline.S as Record<string, unknown> | Array<Record<string, unknown>>);
            for (const entry of entries) {
              const r = Number(entry['@_r'] ?? 0);
              count += 1 + Math.max(0, r);
            }
          } else {
            count = Number(template['@_segmentCount'] ?? 1);
          }

          for (let i = 0; i < count; i++) {
            const num = startNumber + i;
            const rel = mediaPattern
              .replace(/\$RepresentationID\$/g, repId)
              .replace(/\$Number(?::%0\d+d)?\$/g, String(num));
            segments.push({
              index: i,
              uri: resolveUrl(repBase, rel),
              initUri,
            });
          }
        } else if (segmentList) {
          const initObj = segmentList.Initialization as Record<string, unknown> | undefined;
          const initUri = initObj?.['@_sourceURL']
            ? resolveUrl(repBase, String(initObj['@_sourceURL']))
            : undefined;
          const segUrls = asArray(
            segmentList.SegmentURL as Record<string, unknown> | Array<Record<string, unknown>>,
          );
          segUrls.forEach((su, idx) => {
            const media = String(su['@_media'] ?? '');
            if (media) {
              segments.push({
                index: idx,
                uri: resolveUrl(repBase, media),
                initUri,
              });
            }
          });
        } else if (typeof rep.BaseURL === 'string') {
          segments.push({
            index: 0,
            uri: repBase,
          });
        }

        const item: DashRepresentation = {
          id: repId,
          mediaType,
          bandwidth,
          height,
          segments,
        };
        if (mediaType === 'audio') {
          audioRepresentations.push(item);
        } else {
          videoRepresentations.push(item);
        }
      }
    }
  }

  videoRepresentations.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  audioRepresentations.sort((a, b) => b.bandwidth - a.bandwidth);

  return { videoRepresentations, audioRepresentations };
}

