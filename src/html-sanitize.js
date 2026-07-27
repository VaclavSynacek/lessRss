'use strict';

const sanitizeHtml = require('sanitize-html');
const { MAX_FEED_BYTES, httpUrl, truncateUtf8 } = require('./feed-security');

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  'audio',
  'canvas',
  'details',
  'dialog',
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
  img: ['longdesc', 'src'],
  ins: ['cite'],
  q: ['cite'],
  source: ['src'],
  track: ['src'],
  video: ['poster', 'src'],
};

function sanitizeArticleHtml(html, baseUrl = '') {
  if (!html) return '';
  const sanitized = sanitizeHtml(String(html), {
    allowedTags,
    allowedAttributes,
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: true,
    allowAriaAttributes: true,
    transformTags: {
      '*': (tagName, attribs) => transformTag(tagName, attribs, baseUrl),
    },
  });
  return truncateUtf8(sanitized, MAX_FEED_BYTES);
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
    if (!out[attr]) continue;
    const url = httpUrl(out[attr], baseUrl, { allowFragment: tagName === 'a' && attr === 'href' });
    if (url) out[attr] = url;
    else delete out[attr];
  }
  if (out.srcset) out.srcset = absoluteSrcset(out.srcset, baseUrl);

  if (tagName === 'audio' || tagName === 'video') {
    if (!out.controls) out.controls = 'controls';
    if (!out.preload) out.preload = 'none';
  }
  return { tagName, attribs: out };
}

function absoluteUrl(value, baseUrl = '') {
  return httpUrl(value, baseUrl, { allowFragment: true });
}

function absoluteSrcset(srcset, baseUrl = '') {
  return String(srcset || '').split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return '';
    const pieces = trimmed.split(/\s+/);
    pieces[0] = httpUrl(pieces[0], baseUrl);
    return pieces[0] ? pieces.join(' ') : '';
  }).filter(Boolean).join(', ');
}

module.exports = { sanitizeArticleHtml, absoluteUrl, absoluteSrcset };
