/**
 * /guide, rendered inside the dashboard shell.
 *
 * Source of truth is docs/guides/vantage-playbook.html. We extract the guide
 * document body and scope its CSS locally so this route cannot nest another app
 * shell inside the dashboard.
 */
import type { ReactElement } from 'react';
import { GUIDE_HTML } from './guideHtml';

export const metadata = { title: 'Guide · Vantage' };

const GUIDE_CSS = buildGuideCss(GUIDE_HTML);
const GUIDE_BODY = getHtmlPart(GUIDE_HTML, /<body[^>]*>([\s\S]*?)<\/body>/i);

export default function GuidePage(): ReactElement {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: GUIDE_CSS }} />
      <article
        className="vantage-guide min-h-[calc(100vh-3.25rem)]"
        dangerouslySetInnerHTML={{ __html: GUIDE_BODY }}
      />
    </>
  );
}

function buildGuideCss(html: string): string {
  const rawCss = getHtmlPart(html, /<style[^>]*>([\s\S]*?)<\/style>/i);
  const rootCss = getCssBlock(rawCss, ':root');
  const bodyCss = getCssBlock(rawCss, 'body');
  const localRules = rawCss
    .replace(/:root\s*\{[\s\S]*?\}\s*/g, '')
    .replace(/\*\s*\{\s*box-sizing\s*:\s*border-box\s*\}\s*/g, '')
    .replace(/html\s*\{\s*scroll-behavior\s*:\s*smooth\s*\}\s*/g, '')
    .replace(/body\s*\{[\s\S]*?\}\s*/g, '');

  return [
    `.vantage-guide{${rootCss}${bodyCss}scroll-behavior:smooth;}`,
    '.vantage-guide,.vantage-guide *{box-sizing:border-box;}',
    scopeCss(localRules),
  ].join('\n');
}

function getHtmlPart(html: string, pattern: RegExp): string {
  return html.match(pattern)?.[1] ?? '';
}

function getCssBlock(css: string, selector: string): string {
  const match = css.match(new RegExp(`${escapeRegex(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? '';
}

function scopeCss(css: string): string {
  let out = '';
  let cursor = 0;

  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) {
      out += css.slice(cursor);
      break;
    }

    const selector = css.slice(cursor, open).trim();
    const close = findMatchingBrace(css, open);
    if (close === -1) {
      out += css.slice(cursor);
      break;
    }

    const block = css.slice(open + 1, close);
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      out += `${selector}{${scopeCss(block)}}`;
    } else if (selector.startsWith('@')) {
      out += `${selector}{${block}}`;
    } else if (selector.length > 0) {
      out += `${scopeSelector(selector)}{${block}}`;
    }

    cursor = close + 1;
  }

  return out;
}

function scopeSelector(selector: string): string {
  return selector
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      return `.vantage-guide ${trimmed}`;
    })
    .join(', ');
}

function findMatchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
