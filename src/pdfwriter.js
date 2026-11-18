/* Syncrofin 3D Planner — a small PDF writer, no library needed.

   Enough for the loading-order document: A4 pages with text in Helvetica
   and Helvetica-Bold (the 14 standard PDF fonts need no embedding; WinAnsi
   encoding covers Portuguese accents), filled and stroked rectangles, lines
   and JPEG pictures (a canvas's toDataURL('image/jpeg') goes in as it is).

   Coordinates are in points (1/72 in) from the top-left corner of the page,
   text positioned by its baseline. Plain functions, no DOM: the page and
   the tests use it as window.SyncrofinPdf. */

(function (root) {
  'use strict';

  var A4 = { width: 595.28, height: 841.89 };

  /* Helvetica and Helvetica-Bold advance widths (1/1000 em), characters 32-126 */
  var W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278,
    556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  var W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
    722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611,
    722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
    556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333,
    611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
  var W_EXTRA = { '·': 278, '×': 584, '³': 333, '²': 333, '°': 400, '—': 1000, '–': 556, '…': 1000, '•': 350, 'º': 365, 'ª': 370 };

  /* WinAnsi (cp1252) codes of the characters above 0x7f that differ from Latin-1 */
  var WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

  function charWidth(ch, bold) {
    var c = ch.charCodeAt(0);
    var table = bold ? W_BOLD : W_REG;
    if (c >= 32 && c <= 126) return table[c - 32];
    if (W_EXTRA[ch]) return W_EXTRA[ch];
    /* an accented letter is as wide as its letter */
    var base = ch.normalize ? ch.normalize('NFD').charAt(0) : ch;
    var b = base.charCodeAt(0);
    if (b >= 32 && b <= 126) return table[b - 32];
    return 556;
  }

  function textWidth(str, size, bold) {
    var w = 0;
    var s = String(str);
    for (var i = 0; i < s.length; i++) w += charWidth(s.charAt(i), bold);
    return (w * size) / 1000;
  }

  /* a PDF string literal, all ASCII: other bytes as octal escapes */
  function pdfString(str) {
    var out = '(';
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var c = ch.charCodeAt(0);
      if (WIN[ch]) c = WIN[ch];
      else if (c > 255 || (c >= 0x80 && c < 0xa0)) c = ch === '→' ? 0x3e : 0x3f; /* '>' or '?' */
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
      else if (c < 32 || c > 126) out += '\\' + ('00' + c.toString(8)).slice(-3);
      else out += String.fromCharCode(c);
    }
    return out + ')';
  }

  function num(v) {
    return (Math.round(v * 100) / 100).toString();
  }

  function rgb(c) {
    return c.map(function (v) {
      return num(v > 1 ? v / 255 : v);
    }).join(' ');
  }

  /* '#5fc2ea' → [r, g, b] (0-255) */
  function hex(h) {
    var s = String(h || '#000').replace('#', '');
    if (s.length === 3) s = s.replace(/(.)/g, '$1$1');
    return [0, 2, 4].map(function (i) {
      return parseInt(s.slice(i, i + 2), 16) || 0;
    });
  }

  function base64Bytes(b64) {
    var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* Breaks text into lines no wider than maxW (words cut only when a single
     word is wider than the line). */
  function wrap(str, size, bold, maxW) {
    var words = String(str).split(/\s+/).filter(Boolean);
    var lines = [];
    var line = '';
    words.forEach(function (w) {
      var tryLine = line ? line + ' ' + w : w;
      if (textWidth(tryLine, size, bold) <= maxW || !line) {
        line = tryLine;
      } else {
        lines.push(line);
        line = w;
      }
      while (textWidth(line, size, bold) > maxW && line.length > 1) {
        var cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function create(opts) {
    opts = opts || {};
    var PW = opts.width || A4.width;
    var PH = opts.height || A4.height;
    var pages = [];
    var images = [];
    var page = null;

    function addPage() {
      page = { ops: [] };
      pages.push(page);
      return page;
    }

    function Y(y) {
      return PH - y;
    }

    var doc = {
      width: PW,
      height: PH,
      addPage: addPage,
      pageCount: function () {
        return pages.length;
      },
      /* back to page i (0-based), e.g. to write "page i of n" at the end */
      goTo: function (i) {
        page = pages[i] || page;
      },
      textWidth: textWidth,
      wrap: wrap,
      /* o: { size, bold, color: [r,g,b], align: 'left'|'center'|'right' } */
      text: function (x, y, str, o) {
        o = o || {};
        var size = o.size || 10;
        var w = textWidth(str, size, o.bold);
        if (o.align === 'center') x -= w / 2;
        else if (o.align === 'right') x -= w;
        page.ops.push('BT /' + (o.bold ? 'F2' : 'F1') + ' ' + num(size) + ' Tf ' + rgb(o.color || [0, 0, 0]) + ' rg 1 0 0 1 ' +
          num(x) + ' ' + num(Y(y)) + ' Tm ' + pdfString(str) + ' Tj ET');
        return w;
      },
      /* o: { fill: [r,g,b], stroke: [r,g,b], lw, dash: [on, off] } */
      rect: function (x, y, w, h, o) {
        o = o || {};
        var s = 'q ';
        if (o.dash) s += '[' + o.dash.map(num).join(' ') + '] 0 d ';
        if (o.fill) s += rgb(o.fill) + ' rg ';
        if (o.stroke) s += rgb(o.stroke) + ' RG ' + num(o.lw || 0.5) + ' w ';
        s += num(x) + ' ' + num(Y(y + h)) + ' ' + num(w) + ' ' + num(h) + ' re ';
        s += o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S';
        page.ops.push(s + ' Q');
      },
      line: function (x1, y1, x2, y2, o) {
        o = o || {};
        var s = 'q ' + rgb(o.stroke || [0, 0, 0]) + ' RG ' + num(o.lw || 0.5) + ' w ';
        if (o.dash) s += '[' + o.dash.map(num).join(' ') + '] 0 d ';
        page.ops.push(s + num(x1) + ' ' + num(Y(y1)) + ' m ' + num(x2) + ' ' + num(Y(y2)) + ' l S Q');
      },
      /* jpeg: bytes, or a 'data:image/jpeg;base64,…' URL; pw × ph pixels */
      image: function (jpeg, pw, ph, x, y, w, h) {
        var bytes = typeof jpeg === 'string' ? base64Bytes(jpeg.slice(jpeg.indexOf(',') + 1)) : jpeg;
        var name = 'Im' + (images.length + 1);
        images.push({ name: name, bytes: bytes, w: pw, h: ph });
        page.ops.push('q ' + num(w) + ' 0 0 ' + num(h) + ' ' + num(x) + ' ' + num(Y(y + h)) + ' cm /' + name + ' Do Q');
      },
      output: function () {
        return build(PW, PH, pages, images);
      }
    };
    return doc;
  }

  /* The file: catalog, page tree, the two fonts, the pictures, then each page
     and its content; a cross-reference table at the end. */
  function build(PW, PH, pages, images) {
    var chunks = [];
    var length = 0;
    var offsets = [];
    function put(part) {
      if (typeof part === 'string') {
        var b = new Uint8Array(part.length);
        for (var i = 0; i < part.length; i++) b[i] = part.charCodeAt(i) & 0xff;
        part = b;
      }
      chunks.push(part);
      length += part.length;
    }
    function obj(n, body) {
      offsets[n] = length;
      put(n + ' 0 obj\n');
      if (typeof body === 'string') put(body);
      else body.forEach(put);
      put('\nendobj\n');
    }

    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    /* 1 catalog, 2 pages, 3-4 fonts, then images, then page + content pairs */
    var first = 5;
    var imageNo = {};
    images.forEach(function (im, i) {
      imageNo[im.name] = first + i;
    });
    var pageStart = first + images.length;
    var kids = pages.map(function (p, i) {
      return pageStart + i * 2 + ' 0 R';
    });
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    images.forEach(function (im) {
      obj(imageNo[im.name], [
        '<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>\nstream\n',
        im.bytes,
        '\nendstream'
      ]);
    });
    var xobjects = images.map(function (im) {
      return '/' + im.name + ' ' + imageNo[im.name] + ' 0 R';
    }).join(' ');
    pages.forEach(function (p, i) {
      var n = pageStart + i * 2;
      var content = p.ops.join('\n');
      obj(n, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(PW) + ' ' + num(PH) + '] ' +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + (xobjects ? ' /XObject << ' + xobjects + ' >>' : '') + ' >> ' +
        '/Contents ' + (n + 1) + ' 0 R >>');
      obj(n + 1, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    });
    var total = pageStart + pages.length * 2;
    var xref = length;
    var table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) table += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
    put(table);
    put('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    var out = new Uint8Array(length);
    var at = 0;
    chunks.forEach(function (c) {
      out.set(c, at);
      at += c.length;
    });
    return out;
  }

  root.SyncrofinPdf = { A4: A4, create: create, textWidth: textWidth, wrap: wrap, hex: hex };
})(typeof window !== 'undefined' ? window : this);
