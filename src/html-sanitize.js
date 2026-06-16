'use strict';

const sanitizeHtml = require('sanitize-html');

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  'audio',
  'canvas',
  'details',
  'dialog',
  'iframe',
  'img',
  'picture',
  'source',
  'summary',
  'track',
  'video',
];

const allowedAttributes = {
  '*': [
    'aria-*',
    'data-*',
    'dir',
    'draggable',
    'hidden',
    'lang',
    'role',
    'title',
  ],
  a: ['href', 'hreflang', 'name', 'target', 'type'],
  audio: ['controls', 'controlslist', 'loop', 'muted', 'preload', 'src'],
  blockquote: ['cite'],
  col: ['span', 'align', 'valign', 'width'],
  colgroup: ['span', 'align', 'valign', 'width'],
  del: ['cite', 'datetime'],
  iframe: ['allow', 'allowfullscreen', 'align', 'frameborder', 'height', 'longdesc', 'marginheight', 'marginwidth', 'sandbox', 'scrolling', 'src', 'width'],
  img: ['align', 'alt', 'border', 'height', 'hspace', 'loading', 'longdesc', 'src', 'srcset', 'title', 'vspace', 'width'],
  ins: ['cite', 'datetime'],
  li: ['type', 'value'],
  ol: ['reversed', 'start', 'type'],
  p: ['align'],
  pre: ['width', 'wrap'],
  q: ['cite'],
  source: ['height', 'media', 'src', 'srcset', 'type', 'width'],
  table: ['align', 'border', 'cellpadding', 'cellspacing', 'rules', 'summary', 'width'],
  tbody: ['align', 'char', 'charoff', 'valign'],
  td: ['abbr', 'align', 'colspan', 'headers', 'height', 'rowspan', 'scope', 'valign', 'width'],
  tfoot: ['align', 'valign'],
  th: ['abbr', 'align', 'colspan', 'height', 'rowspan', 'scope', 'valign', 'width'],
  thead: ['align', 'valign'],
  time: ['datetime'],
  tr: ['align', 'valign'],
  track: ['default', 'kind', 'label', 'src', 'srclang'],
  ul: ['type'],
  video: ['controls', 'controlslist', 'height', 'loop', 'muted', 'playsinline', 'poster', 'preload', 'src', 'width'],
};

const urlAttributes = {
  a: ['href'],
  audio: ['src'],
  blockquote: ['cite'],
  del: ['cite'],
  iframe: ['longdesc', 'src'],
  img: ['longdesc', 'src'],
  ins: ['cite'],
  q: ['cite'],
  source: ['src'],
  track: ['src'],
  video: ['poster', 'src'],
};

function sanitizeArticleHtml(html, baseUrl = '') {
  if (!html) return '';
  return sanitizeHtml(String(html), {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ['http', 'https', 'ftp', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: true,
    allowAriaAttributes: true,
    allowedIframeHostnames: false,
    transformTags: {
      '*': (tagName, attribs) => transformTag(tagName, attribs, baseUrl),
    },
  });
}

function transformTag(tagName, attribs, baseUrl) {
  const out = { ...attribs };

  if (out.id) {
    out['data-sanitized-id'] = out.id;
    delete out.id;
  }
  if (out.class) {
    out['data-sanitized-class'] = out.class;
    delete out.class;
  }

  for (const attr of urlAttributes[tagName] || []) {
    if (out[attr]) out[attr] = absoluteUrl(out[attr], baseUrl);
  }
  if (out.srcset) out.srcset = absoluteSrcset(out.srcset, baseUrl);

  if (tagName === 'audio' || tagName === 'video') {
    if (!out.controls) out.controls = 'controls';
    if (!out.preload) out.preload = 'none';
  }
  if (tagName === 'iframe') {
    if (!out.sandbox) out.sandbox = 'allow-scripts allow-same-origin';
    if (!out.allow) out.allow = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    if (!out.allowfullscreen) out.allowfullscreen = 'allowfullscreen';
  }

  return { tagName, attribs: out };
}

function absoluteUrl(value, baseUrl = '') {
  const s = String(value || '').trim();
  if (!s || s.startsWith('#')) return s;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(s)) return s;
  if (!baseUrl) return s;
  try {
    return new URL(s, baseUrl).href;
  } catch {
    return s;
  }
}

function absoluteSrcset(srcset, baseUrl = '') {
  return String(srcset || '').split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    const pieces = trimmed.split(/\s+/);
    pieces[0] = absoluteUrl(pieces[0], baseUrl);
    return pieces.join(' ');
  }).filter(Boolean).join(', ');
}

module.exports = { sanitizeArticleHtml, absoluteUrl, absoluteSrcset };
