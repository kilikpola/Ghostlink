(function(exports) {
  'use strict';

  // Resolve the sanitizer: sanitize.js publishes itself on globalThis in the
  // browser; fall back to require() for CommonJS.
  var Sanitizer = null;
  if (typeof globalThis !== 'undefined' && typeof globalThis.isSafeURL === 'function') {
    Sanitizer = globalThis;
  } else {
    try {
      Sanitizer = require('./sanitize');
    } catch (e) {
      Sanitizer = null;
    }
  }

  var INLINE_TAGS = ['strong', 'em', 'code', 'del', 'a', 'br', 'span'];
  var BLOCK_TAGS = ['p', 'div', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  var ESCAPE_CHARS = '\\`*_{}[]>#+-.!|~^';
  // As in sanitize.js: these must be entities, not their own decoded form.
  // With identity mappings escapeHTML returned '<script>' unchanged, so the
  // markdown pipeline handed raw peer markup straight to the renderer.
  var HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '`': '&#x60;'
  };

  var defaultOptions = {
    breaks: false,
    gfm: true,
    headerLevelStart: 1,
    linkify: false,
    sanitize: true,
    silent: false,
    tables: false,
    xhtml: false
  };

  function escapeHTML(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text.replace(/[&<>"'`]/g, function(char) {
      return HTML_ESCAPE_MAP[char] || char;
    });
  }

  function unescapeHTML(text) {
    if (typeof text !== 'string') {
      return '';
    }

    var unescapeMap = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#x27;': "'",
      '&apos;': "'",
      '&#39;': "'",
      '&#x60;': '`'
    };

    return text.replace(/&(?:amp|lt|gt|quot|apos|#x27|#x60|#39);/g, function(entity) {
      return unescapeMap[entity] || entity;
    });
  }

  function encodeHTML(text) {
    if (typeof text !== 'string') {
      return '';
    }

    return text.replace(/[&<>"']/g, function(char) {
      return '&#' + char.charCodeAt(0) + ';';
    });
  }

  function preprocessText(text, options) {
    if (typeof text !== 'string') {
      return '';
    }

    text = text.replace(/\r\n|\r/g, '\n');

    if (!options || options.breaks !== true) {
      text = text.replace(/\n\n+/g, '\n\n');
    }

    text = text.replace(/^[ \t]+$/gm, '');

    text = text.replace(/\t/g, '    ');

    return text;
  }

  function preprocessInline(text) {
    if (typeof text !== 'string') {
      return '';
    }

    text = text.replace(/\n/g, ' ');

    text = text.replace(/\s+/g, ' ');

    text = text.trim();

    return text;
  }

  function parseInline(text) {
    if (typeof text !== 'string') {
      return '';
    }

    var result = escapeHTML(text);

    var inlineCodeRegex = /\\`([^`]+)\\`/g;
    result = result.replace(inlineCodeRegex, function(match, code) {
      return '<code>' + code + '</code>';
    });

    var codeRegex = /`([^`]+)`/g;
    result = result.replace(codeRegex, function(match, code) {
      return '<code>' + code + '</code>';
    });

    var strikeRegex = /~~([^~]+)~~/g;
    result = result.replace(strikeRegex, function(match, content) {
      return '<del>' + content + '</del>';
    });

    var boldUnderscoreRegex = /__([^_]+)__/g;
    result = result.replace(boldUnderscoreRegex, function(match, content) {
      return '<strong>' + content + '</strong>';
    });

    var boldRegex = /\*\*([^*]+)\*\*/g;
    result = result.replace(boldRegex, function(match, content) {
      return '<strong>' + content + '</strong>';
    });

    var italicUnderscoreRegex = /_([^_]+)_/g;
    result = result.replace(italicUnderscoreRegex, function(match, content) {
      return '<em>' + content + '</em>';
    });

    var italicRegex = /\*([^*]+)\*/g;
    result = result.replace(italicRegex, function(match, content) {
      return '<em>' + content + '</em>';
    });

    var linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    result = result.replace(linkRegex, function(match, linkText, url) {
      linkText = linkText || '';
      url = url || '#';

      // No sanitizer means no way to vet the URL — render the label as plain
      // text rather than emit an href nothing has checked.
      if (!Sanitizer || !Sanitizer.isSafeURL(url)) {
        return linkText;
      }

      return '<a href="' + escapeHTML(url) + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>';
    });

    result = result.replace(/\\([\\*_`~[\]()>#+!.|^])/g, function(match, char) {
      return char;
    });

    return result;
  }

  function parseInlineOnly(text) {
    if (typeof text !== 'string') {
      return '';
    }

    text = preprocessInline(text);

    var result = parseInline(text);

    return result;
  }

  function parseCodeBlock(lines, indent) {
    if (!lines || !Array.isArray(lines)) {
      return '';
    }

    var codeLines = [];
    var inCodeBlock = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      var codeStartRegex = new RegExp('^(\\s*)```');
      var codeStartMatch = line.match(codeStartRegex);

      if (codeStartMatch) {
        if (inCodeBlock) {
          inCodeBlock = false;
          continue;
        } else {
          inCodeBlock = true;
          continue;
        }
      }

      if (inCodeBlock) {
        var lineIndent = line.match(/^(\s*)/)[1].length;
        if (lineIndent >= indent) {
          codeLines.push(line.substring(indent));
        } else {
          codeLines.push(line);
        }
      }
    }

    return codeLines.join('\n');
  }

  function parseBlockquote(lines) {
    if (!lines || !Array.isArray(lines)) {
      return [];
    }

    var quoteLines = [];
    var currentIndent = -1;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var blockquoteRegex = /^(\s*)>\s*(.*)$/;
      var match = line.match(blockquoteRegex);

      if (!match) {
        break;
      }

      var indent = match[1].length;
      var content = match[2];

      if (currentIndent === -1) {
        currentIndent = indent;
      }

      if (indent < currentIndent) {
        break;
      }

      quoteLines.push(content);
    }

    return quoteLines;
  }

  function parseHeading(line, options) {
    if (typeof line !== 'string') {
      return null;
    }

    var headingRegex = /^(\s*)#{1,6}\s+(.+)$/;
    var match = line.match(headingRegex);

    if (!match) {
      return null;
    }

    var level = match[1].length + 1;
    var text = match[2];

    if (options && options.headerLevelStart !== undefined) {
      level = level + options.headerLevelStart - 1;
      if (level < 1) level = 1;
      if (level > 6) level = 6;
    }

    var html = parseInline(text);

    return '<' + 'h' + level + '>' + html + '</' + 'h' + level + '>';
  }

  function parseHR(line) {
    if (typeof line !== 'string') {
      return false;
    }

    var hrVariants = [
      /^(\s*)-{3,}\s*$/,
      /^(\s*)\*{3,}\s*$/,
      /^(\s*)_{3,}\s*$/
    ];

    for (var i = 0; i < hrVariants.length; i++) {
      if (hrVariants[i].test(line)) {
        return true;
      }
    }

    return false;
  }

  function parseUnorderedList(line) {
    if (typeof line !== 'string') {
      return null;
    }

    var listRegex = /^(\s*)([-*+])\s+(.+)$/;
    var match = line.match(listRegex);

    if (!match) {
      return null;
    }

    return {
      indent: match[1].length,
      marker: match[2],
      content: match[3]
    };
  }

  function parseOrderedList(line) {
    if (typeof line !== 'string') {
      return null;
    }

    var orderedListRegex = /^(\s*)(\d+)\.\s+(.+)$/;
    var match = line.match(orderedListRegex);

    if (!match) {
      return null;
    }

    return {
      indent: match[1].length,
      number: parseInt(match[2], 10),
      content: match[3]
    };
  }

  function parseParagraph(lines) {
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return '';
    }

    var paragraphText = lines.join(' ');

    paragraphText = paragraphText.replace(/\s+/g, ' ');
    paragraphText = paragraphText.trim();

    if (paragraphText === '') {
      return '';
    }

    var html = parseInline(paragraphText);

    return '<p>' + html + '</p>';
  }

  function parseBlock(text, options) {
    if (typeof text !== 'string') {
      return '';
    }

    text = preprocessText(text, options);

    var lines = text.split('\n');
    var result = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (line.trim() === '') {
        i++;
        continue;
      }

      var headingResult = parseHeading(line, options);
      if (headingResult) {
        result.push(headingResult);
        i++;
        continue;
      }

      if (parseHR(line)) {
        result.push('<hr>');
        i++;
        continue;
      }

      var codeStartRegex = /^(\s*)```/;
      if (codeStartRegex.test(line)) {
        var codeLines = [line];
        i++;
        while (i < lines.length) {
          var currentLine = lines[i];
          codeLines.push(currentLine);

          var codeEndRegex = /^(\s*)```/;
          if (codeEndRegex.test(currentLine)) {
            break;
          }
          i++;
        }

        var codeText = codeLines.join('\n');
        var codeBlockMatch = codeText.match(/```(\w*)\n([\s\S]*?)```/);
        var codeContent = '';
        if (codeBlockMatch && codeBlockMatch[2]) {
          codeContent = codeBlockMatch[2];
        } else {
          codeContent = codeLines.slice(1, -1).join('\n');
        }

        result.push('<pre><code>' + escapeHTML(codeContent) + '</code></pre>');
        i++;
        continue;
      }

      var blockquoteMatch = line.match(/^(\s*)>\s*(.*)$/);
      if (blockquoteMatch) {
        var quoteLines = [];
        var quoteIndent = blockquoteMatch[1].length;

        while (i < lines.length) {
          var currentLineQ = lines[i];
          var matchQ = currentLineQ.match(/^(\s*)>\s*(.*)$/);

          if (!matchQ) {
            break;
          }

          var currentIndent = matchQ[1].length;
          if (currentIndent < quoteIndent) {
            break;
          }

          quoteLines.push(matchQ[2]);
          i++;
        }

        var quoteContent = quoteLines.join(' ');
        var quoteHTML = parseInline(quoteContent);
        result.push('<blockquote>' + quoteHTML + '</blockquote>');
        continue;
      }

      var paragraphLines = [];
      while (i < lines.length) {
        var currentLineRaw = lines[i];

        if (currentLineRaw.trim() === '') {
          break;
        }

        if (/^#{1,6}\s/.test(currentLineRaw)) {
          break;
        }

        if (/^(\s*)```/.test(currentLineRaw)) {
          break;
        }

        if (/^(\s*)>\s/.test(currentLineRaw)) {
          break;
        }

        if (/^(\s*)([-*+])\s+/.test(currentLineRaw)) {
          break;
        }

        if (/^(\s*)\d+\.\s+/.test(currentLineRaw)) {
          break;
        }

        if (parseHR(currentLineRaw)) {
          break;
        }

        paragraphLines.push(currentLineRaw);
        i++;
      }

      if (paragraphLines.length > 0) {
        var paragraphHTML = parseParagraph(paragraphLines);
        if (paragraphHTML) {
          result.push(paragraphHTML);
        }
      }
    }

    return result.join('\n');
  }

  function parseMarkdown(text, options) {
    if (typeof text !== 'string') {
      return '';
    }

    options = options || defaultOptions;

    if (text.trim() === '') {
      return '';
    }

    var blockHTML = parseBlock(text, options);

    if (options.sanitize !== false && Sanitizer) {
      blockHTML = Sanitizer.sanitizeHTML(blockHTML);
    }

    return blockHTML;
  }

  function MarkdownParser(options) {
    this.options = options || defaultOptions;
  }

  MarkdownParser.prototype.parse = function(text) {
    return parseMarkdown(text, this.options);
  };

  MarkdownParser.prototype.parseInline = function(text) {
    return parseInline(text);
  };

  MarkdownParser.prototype.parseInlineOnly = function(text) {
    return parseInlineOnly(text);
  };

  MarkdownParser.prototype.parseBlock = function(text) {
    return parseBlock(text, this.options);
  };

  MarkdownParser.prototype.parseParagraph = function(lines) {
    return parseParagraph(lines);
  };

  MarkdownParser.prototype.escapeHTML = function(text) {
    return escapeHTML(text);
  };

  MarkdownParser.prototype.unescapeHTML = function(text) {
    return unescapeHTML(text);
  };

  MarkdownParser.prototype.setOption = function(key, value) {
    if (key && typeof key === 'string') {
      this.options[key] = value;
    }
  };

  MarkdownParser.prototype.getOption = function(key) {
    if (key && typeof key === 'string') {
      return this.options[key];
    }
    return null;
  };

  MarkdownParser.escapeHTML = function(text) {
    return escapeHTML(text);
  };

  MarkdownParser.unescapeHTML = function(text) {
    return unescapeHTML(text);
  };

  MarkdownParser.encodeHTML = function(text) {
    return encodeHTML(text);
  };

  MarkdownParser.preprocessText = function(text, options) {
    return preprocessText(text, options);
  };

  MarkdownParser.preprocessInline = function(text) {
    return preprocessInline(text);
  };

  MarkdownParser.INLINE_TAGS = INLINE_TAGS.slice();
  MarkdownParser.BLOCK_TAGS = BLOCK_TAGS.slice();
  MarkdownParser.ESCAPE_CHARS = ESCAPE_CHARS.split('');
  MarkdownParser.defaultOptions = defaultOptions;

  exports.parseMarkdown = parseMarkdown;
  exports.MarkdownParser = MarkdownParser;
  exports.escapeHTML = escapeHTML;
  exports.unescapeHTML = unescapeHTML;
  exports.encodeHTML = encodeHTML;
  exports.preprocessText = preprocessText;
  exports.preprocessInline = preprocessInline;

})(typeof globalThis !== 'undefined' ? globalThis : this);