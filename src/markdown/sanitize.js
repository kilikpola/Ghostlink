(function(exports) {
  'use strict';

  var ALLOWED_TAGS = ['strong', 'em', 'code', 'pre', 'del', 'blockquote', 'br', 'a'];
  var ALLOWED_ATTRS = ['href', 'target', 'rel'];
  var BLOCK_TAGS = ['p', 'div', 'br', 'blockquote', 'pre', 'code', 'strong', 'em', 'del', 'a'];
  var DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'livescript:', 'mocha:', 'coffeescript:'];
  var DANGEROUS_ATTRS = [
    'onclick', 'oncontextmenu', 'oncopy', 'oncut', 'ondblclick',
    'ondrag', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover',
    'ondragstart', 'ondrop', 'onerror', 'onfocus', 'onhashchange',
    'oninput', 'oninvalid', 'onkeydown', 'onkeypress', 'onkeyup',
    'onload', 'onmousedown', 'onmousemove', 'onmouseout', 'onmouseover',
    'onmouseup', 'onmousewheel', 'onpaste', 'onreset', 'onresize',
    'onscroll', 'onsearch', 'onselect', 'onsubmit', 'ontouchcancel',
    'ontouchend', 'ontouchmove', 'ontouchstart', 'onunload', 'onwheel',
    'onloadstart', 'onprogress', 'onloadend', 'onbeforeunload', 'onmessage',
    'onopen', 'onshow', 'ontoggle', 'onratechange', 'onended', 'onloadedmetadata',
    'onwaiting', 'onplaying', 'onpause', 'onseeking', 'onseeked', 'onstalled',
    'onsuspend', 'onabort', 'oncanplay', 'oncanplaythrough', 'ondurationchange',
    'onemptied', 'onloadeddata', 'onplay', 'ontimeupdate', 'onvolumechange',
    'onanimationstart', 'onanimationend', 'onanimationiteration',
    'ontransitionend', 'onpointerdown', 'onpointerup', 'onpointermove',
    'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
    'ongotpointercapture', 'onlostpointercapture', 'onstorage'
  ];
  var DANGEROUS_TAGS = [
    'script', 'iframe', 'style', 'img', 'svg', 'math', 'object', 'embed',
    'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base',
    'applet', 'area', 'audio', 'video', 'source', 'track', 'canvas', 'map',
    'noscript', 'noframes', 'plaintext', 'xmp', 'template', 'slot', 'shadow'
  ];

  // Values must stay written as entities. Apply the ampersand rule first on
  // escape and last on unescape.
  var HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };

  var HTML_UNESCAPE_MAP = {
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&apos;': "'",
    '&#39;': "'",
    '&#x2F;': '/',
    '&#x60;': '`',
    '&#x3D;': '=',
    '&amp;': '&'
  };

  function isSafeURL(url) {
    if (typeof url !== 'string') {
      return false;
    }

    var trimmedUrl = url.trim().toLowerCase();

    if (trimmedUrl === '' || trimmedUrl === '#' || trimmedUrl === '/' ||
        trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://') ||
        trimmedUrl.startsWith('mailto:') || trimmedUrl.startsWith('tel:')) {
      return true;
    }

    for (var i = 0; i < DANGEROUS_PROTOCOLS.length; i++) {
      if (trimmedUrl.startsWith(DANGEROUS_PROTOCOLS[i])) {
        return false;
      }
    }

    if (trimmedUrl.startsWith('//')) {
      return false;
    }

    if (trimmedUrl.startsWith('/') && !trimmedUrl.startsWith('//')) {
      return true;
    }

    if (trimmedUrl.startsWith('./') || trimmedUrl.startsWith('../')) {
      return true;
    }

    return false;
  }

  function validateAttribute(name, value) {
    if (typeof name !== 'string') {
      return false;
    }

    var lowerName = name.toLowerCase().trim();

    if (DANGEROUS_ATTRS.indexOf(lowerName) !== -1) {
      return false;
    }

    if (lowerName.startsWith('on')) {
      return false;
    }

    if (lowerName === 'style' || lowerName === 'class' || lowerName === 'id') {
      return false;
    }

    if (lowerName === 'style') {
      return false;
    }

    var urlAttrNames = [
      'href', 'src', 'action', 'formaction', 'data', 'poster',
      'background', 'dynsrc', 'lowsrc', 'srcset', 'longdesc', 'cite',
      'profile', 'manifest', 'classid', 'codebase', 'usemap'
    ];

    if (urlAttrNames.indexOf(lowerName) !== -1) {
      if (value && typeof value === 'string') {
        if (!isSafeURL(value)) {
          return false;
        }
      }
    }

    if (lowerName === 'srcset' && value && typeof value === 'string') {
      var srcsetParts = value.split(',');
      for (var i = 0; i < srcsetParts.length; i++) {
        var srcPart = srcsetParts[i].trim().split(/\s+/)[0];
        if (srcPart && !isSafeURL(srcPart)) {
          return false;
        }
      }
    }

    if (lowerName === 'sandbox' && value) {
      var allowedFlags = ['allow-forms', 'allow-modals', 'allow-pointer-lock',
                         'allow-popups', 'allow-popups-to-escape-sandbox',
                         'allow-same-origin', 'allow-scripts', 'allow-top-navigation'];
      var flags = value.split(/\s+/);
      for (var j = 0; j < flags.length; j++) {
        if (allowedFlags.indexOf(flags[j]) === -1) {
          return false;
        }
      }
    }

    return true;
  }

  function stripAllAttributes(node) {
    if (!node) return;

    while (node.attributes && node.attributes.length > 0) {
      node.removeAttribute(node.attributes[0].name);
    }
  }

  function isDangerousTag(tagName) {
    if (!tagName || typeof tagName !== 'string') {
      return true;
    }

    var lowerTag = tagName.toLowerCase().trim();
    return DANGEROUS_TAGS.indexOf(lowerTag) !== -1;
  }

  function isAllowedTag(tagName) {
    if (!tagName || typeof tagName !== 'string') {
      return false;
    }

    var lowerTag = tagName.toLowerCase().trim();
    return ALLOWED_TAGS.indexOf(lowerTag) !== -1;
  }

  function sanitizeNode(node, doc) {
    if (!node || !doc) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      var tagName = node.tagName.toLowerCase();

      if (isDangerousTag(tagName)) {
        if (node.parentNode) {
          var parent = node.parentNode;
          while (node.firstChild) {
            parent.insertBefore(node.firstChild, node);
          }
          parent.removeChild(node);
        }
        return;
      }

      if (!isAllowedTag(tagName)) {
        if (node.parentNode) {
          var targetParent = node.parentNode;
          while (node.firstChild) {
            targetParent.insertBefore(node.firstChild, node);
          }
          targetParent.removeChild(node);
        }
        return;
      }

      var attrs = [];
      if (node.attributes) {
        for (var i = 0; i < node.attributes.length; i++) {
          attrs.push(node.attributes[i]);
        }
      }

      for (var j = 0; j < attrs.length; j++) {
        var attr = attrs[j];
        var attrName = attr.name;
        var attrValue = attr.value;

        if (!validateAttribute(attrName, attrValue)) {
          node.removeAttribute(attrName);
        }
      }

      if (tagName === 'a') {
        var href = node.getAttribute('href');
        if (href && !isSafeURL(href)) {
          node.removeAttribute('href');
        }

        if (!node.getAttribute('target')) {
          node.setAttribute('target', '_blank');
        }
        if (!node.getAttribute('rel')) {
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }

      if (tagName === 'br' || tagName === 'strong' || tagName === 'em' ||
          tagName === 'del' || tagName === 'code' || tagName === 'pre' ||
          tagName === 'blockquote') {
        stripAllAttributes(node);
      }
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return;
    }

    if (node.childNodes) {
      var children = [];
      for (var k = 0; k < node.childNodes.length; k++) {
        children.push(node.childNodes[k]);
      }

      for (var m = 0; m < children.length; m++) {
        sanitizeNode(children[m], doc);
      }
    }
  }

  function sanitizeHTML(html) {
    if (typeof html !== 'string' || html === '') {
      return '';
    }

    if (html.indexOf('<script') !== -1 || html.indexOf('<SCRIPT') !== -1) {
      html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<script[^>]*\/>/gi, '');
      html = html.replace(/<script[^>]*>/gi, '');
    }

    if (html.indexOf('<iframe') !== -1 || html.indexOf('<IFRAME') !== -1) {
      html = html.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
      html = html.replace(/<iframe[^>]*\/>/gi, '');
    }

    if (html.indexOf('<style') !== -1 || html.indexOf('<STYLE') !== -1) {
      html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    }

    if (html.indexOf('<img') !== -1 || html.indexOf('<IMG') !== -1) {
      html = html.replace(/<img[^>]*>/gi, '');
    }

    var doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return '';
    }

    var body = doc.body;
    if (!body) {
      return '';
    }

    var allElements = body.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      sanitizeNode(allElements[i], doc);
    }

    var result = '';
    try {
      result = new XMLSerializer().serializeToString(body);
      var match = result.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      if (match && match[1]) {
        result = match[1];
      } else {
        result = result.replace(/^<body[^>]*>|<\/body>$/gi, '');
      }
    } catch (e) {
      return '';
    }

    result = result.replace(/<\/br>/gi, '<br>');
    result = result.replace(/<br\/>/gi, '<br>');
    result = result.replace(/<br>/gi, '<br>');

    result = result.replace(/\s+>/g, '>');

    return result;
  }

  function escapeHTML(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text.replace(/[&<>"'`=\/]/g, function(match) {
      return HTML_ESCAPE_MAP[match] || match;
    });
  }

  function unescapeHTML(text) {
    if (typeof text !== 'string') {
      return '';
    }

    var result = text;
    var keys = Object.keys(HTML_UNESCAPE_MAP);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = HTML_UNESCAPE_MAP[key];
      result = result.split(key).join(value);
    }

    return result;
  }

  function stripAllHTML(html) {
    if (typeof html !== 'string') {
      return '';
    }

    return html.replace(/<[^>]*>/g, '');
  }

  function validateHTML(html) {
    if (typeof html !== 'string') {
      return { valid: false, error: 'HTML must be a string' };
    }

    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.body) {
        return { valid: false, error: 'Invalid HTML document' };
      }
      return { valid: true, error: null };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  function HTMLSanitizer() {}

  HTMLSanitizer.prototype.sanitize = function(html) {
    return sanitizeHTML(html);
  };

  HTMLSanitizer.prototype.isSafeURL = function(url) {
    return isSafeURL(url);
  };

  HTMLSanitizer.prototype.stripAllAttributes = function(node) {
    return stripAllAttributes(node);
  };

  HTMLSanitizer.prototype.validateAttribute = function(name, value) {
    return validateAttribute(name, value);
  };

  HTMLSanitizer.prototype.isDangerousTag = function(tagName) {
    return isDangerousTag(tagName);
  };

  HTMLSanitizer.prototype.isAllowedTag = function(tagName) {
    return isAllowedTag(tagName);
  };

  HTMLSanitizer.prototype.stripAllHTML = function(html) {
    return stripAllHTML(html);
  };

  HTMLSanitizer.prototype.validateHTML = function(html) {
    return validateHTML(html);
  };

  HTMLSanitizer.escapeHTML = function(text) {
    return escapeHTML(text);
  };

  HTMLSanitizer.unescapeHTML = function(text) {
    return unescapeHTML(text);
  };

  HTMLSanitizer.ALLOWED_TAGS = ALLOWED_TAGS.slice();
  HTMLSanitizer.ALLOWED_ATTRS = ALLOWED_ATTRS.slice();
  HTMLSanitizer.DANGEROUS_TAGS = DANGEROUS_TAGS.slice();
  HTMLSanitizer.DANGEROUS_ATTRS = DANGEROUS_ATTRS.slice();
  HTMLSanitizer.DANGEROUS_PROTOCOLS = DANGEROUS_PROTOCOLS.slice();

  exports.sanitizeHTML = sanitizeHTML;
  exports.HTMLSanitizer = HTMLSanitizer;
  exports.escapeHTML = escapeHTML;
  exports.unescapeHTML = unescapeHTML;
  exports.isSafeURL = isSafeURL;
  exports.validateAttribute = validateAttribute;
  exports.isDangerousTag = isDangerousTag;
  exports.isAllowedTag = isAllowedTag;

})(typeof globalThis !== 'undefined' ? globalThis : this);