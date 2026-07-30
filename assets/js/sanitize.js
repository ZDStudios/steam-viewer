/**
 * Allow-list sanitiser for the HTML Steam hands back in `detailed_description`,
 * `about_the_game`, requirements blocks and news bodies.
 *
 * That markup is authored by developers and publishers, not Valve, so it is
 * treated as untrusted: anything not explicitly permitted is dropped, and the
 * result is built as a fresh DOM tree rather than by re-serialising strings.
 */

const ALLOWED_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DD', 'DIV', 'DL', 'DT', 'EM',
  'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG',
  'LI', 'OL', 'P', 'PICTURE', 'PRE', 'S', 'SMALL', 'SOURCE', 'SPAN', 'STRIKE',
  'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
  'U', 'UL',
  // Steam serves the short looping clips in store descriptions — what reads
  // as a GIF on the real page — as muted <video>. Dropping VIDEO silently
  // deleted most of the animation from every game page.
  'VIDEO',
]);

/** Tags whose entire subtree must go, not just the element itself. */
const DROP_SUBTREE = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'LINK', 'META', 'BASE', 'AUDIO', 'CANVAS']);

const ALLOWED_ATTRS = {
  A: ['href', 'title'],
  IMG: ['src', 'alt', 'title', 'width', 'height'],
  VIDEO: ['src', 'poster', 'width', 'height'],
  SOURCE: ['src', 'type'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
};

/** Only these media types may be referenced by a <source>. */
const SAFE_SOURCE_TYPE = /^(video|image)\/[a-z0-9.+-]+$/i;

const SAFE_LINK = /^(https?:|mailto:)/i;

function safeUrl(value, { requireHttp = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Steam sometimes emits protocol-relative or bare-domain URLs.
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  if (!SAFE_LINK.test(candidate)) return null;
  if (requireHttp && !/^https?:/i.test(candidate)) return null;
  return candidate.replace(/^http:\/\//i, 'https://');
}

/** Steam wraps outbound links in a redirect page; unwrap for a cleaner href. */
function unwrapSteamRedirect(href) {
  try {
    const url = new URL(href);
    if (/steampowered\.com$/i.test(url.hostname) && url.pathname.startsWith('/linkfilter/')) {
      const target = url.searchParams.get('url') || url.searchParams.get('u');
      if (target) return safeUrl(target) || href;
    }
  } catch {
    /* not a parseable URL — leave it alone */
  }
  return href;
}

function sanitizeNode(node, out, doc) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.appendChild(doc.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toUpperCase();
    if (DROP_SUBTREE.has(tag)) continue;

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrapper: keep the readable content, drop the element.
      sanitizeNode(child, out, doc);
      continue;
    }

    const clean = doc.createElement(tag);

    for (const attr of ALLOWED_ATTRS[tag] || []) {
      const value = child.getAttribute(attr);
      if (value === null) continue;

      if (attr === 'href') {
        const href = safeUrl(value);
        if (href) {
          clean.setAttribute('href', unwrapSteamRedirect(href));
          clean.setAttribute('target', '_blank');
          clean.setAttribute('rel', 'noopener noreferrer nofollow');
        }
        continue;
      }
      if (attr === 'src') {
        const src = safeUrl(value, { requireHttp: true });
        if (src) {
          clean.setAttribute('src', src);
          clean.setAttribute('loading', 'lazy');
          clean.setAttribute('referrerpolicy', 'no-referrer');
        }
        continue;
      }
      if (attr === 'poster') {
        const poster = safeUrl(value, { requireHttp: true });
        if (poster) clean.setAttribute('poster', poster);
        continue;
      }
      if (attr === 'type') {
        if (SAFE_SOURCE_TYPE.test(value)) clean.setAttribute('type', value);
        continue;
      }
      if (['width', 'height', 'colspan', 'rowspan'].includes(attr)) {
        if (/^\d{1,4}$/.test(value)) clean.setAttribute(attr, value);
        continue;
      }
      clean.setAttribute(attr, value);
    }

    // Set the playback flags ourselves rather than trusting the markup: these
    // clips stand in for GIFs, so they autoplay muted and loop, and can never
    // make noise or grab focus.
    if (tag === 'VIDEO') {
      clean.muted = true;
      clean.defaultMuted = true;
      clean.loop = true;
      clean.autoplay = true;
      clean.controls = false;
      for (const [flag, flagValue] of [['muted', ''], ['loop', ''], ['autoplay', ''], ['playsinline', ''], ['preload', 'metadata']]) {
        clean.setAttribute(flag, flagValue);
      }
      clean.classList.add('bb_video');
    }

    // An <img> that lost its src is just noise.
    if (tag === 'IMG' && !clean.hasAttribute('src')) continue;

    // A link whose href was rejected would still be styled like a link, so
    // keep the words and drop the anchor.
    if (tag === 'A' && !clean.hasAttribute('href')) {
      sanitizeNode(child, out, doc);
      continue;
    }

    sanitizeNode(child, clean, doc);
    out.appendChild(clean);
  }
}

/** @returns {DocumentFragment} safe to append anywhere. */
export function sanitizeFragment(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const fragment = document.createDocumentFragment();
  sanitizeNode(doc.body, fragment, document);
  return fragment;
}

/** Replace `target`'s children with the sanitised rendering of `html`. */
export function renderRichText(target, html) {
  target.replaceChildren(sanitizeFragment(html));

  for (const video of target.querySelectorAll('video')) {
    // A clip that lost every source would render as a black rectangle.
    if (!video.getAttribute('src') && video.querySelectorAll('source[src]').length === 0) {
      video.remove();
      continue;
    }
    // Some browsers only honour muted autoplay once the node is in the DOM.
    video.play?.().catch(() => {
      /* a clip that will not autoplay is not worth reporting */
    });
  }

  return target;
}
