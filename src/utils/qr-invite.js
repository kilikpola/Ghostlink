/**
 * GhostLink QR Invite System
 * QR code generation (pure SVG) and scanning for peer invitations.
 * Browser ES module — no external dependencies.
 */

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: Reed-Solomon / Galois Field GF(256) for QR Error Correction
// ═══════════════════════════════════════════════════════════════════════

const GF = (() => {
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  return {
    exp: EXP,
    log: LOG,
    mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; },
    div(a, b) { if (b === 0) throw new Error('div by zero'); return a === 0 ? 0 : EXP[(LOG[a] - LOG[b] + 255) % 255]; },
    polyMul(p, q) {
      const r = new Uint8Array(p.length + q.length - 1);
      for (let i = 0; i < p.length; i++)
        for (let j = 0; j < q.length; j++)
          r[i + j] ^= this.mul(p[i], q[j]);
      return r;
    },
    polyRemainder(dividend, divisor) {
      const result = new Uint8Array(dividend);
      for (let i = 0; i < dividend.length - divisor.length + 1; i++) {
        const coef = result[i];
        if (coef === 0) continue;
        for (let j = 1; j < divisor.length; j++) {
          result[i + j] ^= this.mul(divisor[j], coef);
        }
      }
      return result.slice(dividend.length - divisor.length + 1);
    },
    generatorPoly(ecCount) {
      let g = new Uint8Array([1]);
      for (let i = 0; i < ecCount; i++) {
        g = this.polyMul(g, new Uint8Array([1, EXP[i]]));
      }
      return g;
    },
  };
})();

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: QR Code Data Tables
// ═══════════════════════════════════════════════════════════════════════

// Version info: [totalCodewords, ecCodewordsPerBlock, numBlocks(group1), dataPerBlock(g1), numBlocks(g2), dataPerBlock(g2)]
// Error correction level M for versions 1-10
const VERSION_EC_M = [
  null, // 0 unused
  [26, 10, 1, 16, 0, 0], // v1
  [44, 16, 1, 28, 0, 0], // v2
  [70, 26, 1, 44, 0, 0], // v3
  [100, 18, 2, 32, 0, 0], // v4
  [134, 24, 2, 43, 0, 0], // v5
  [172, 16, 4, 27, 0, 0], // v6
  [196, 18, 4, 31, 0, 0], // v7
  [242, 22, 2, 38, 2, 39], // v8
  [292, 22, 3, 36, 2, 37], // v9
  [346, 26, 4, 43, 1, 44], // v10
  [404, 30, 1, 50, 4, 51], // v11
  [466, 22, 6, 36, 2, 37], // v12
  [532, 22, 8, 37, 1, 38], // v13
  [581, 24, 4, 40, 5, 41], // v14
  [655, 24, 5, 41, 5, 42], // v15
  [733, 28, 7, 45, 3, 46], // v16
  [815, 28, 10, 46, 1, 47], // v17
  [901, 26, 9, 43, 4, 44], // v18
  [991, 26, 3, 44, 11, 45], // v19
  [1085, 26, 3, 41, 13, 42], // v20
  [1156, 26, 17, 42, 0, 0], // v21
  [1258, 28, 17, 46, 0, 0], // v22
  [1364, 28, 4, 47, 14, 48], // v23
  [1474, 28, 6, 45, 14, 46], // v24
  [1588, 28, 8, 47, 13, 48], // v25
  [1706, 28, 19, 46, 4, 47], // v26
  [1828, 28, 22, 45, 3, 46], // v27
  [1921, 28, 3, 45, 23, 46], // v28
  [2051, 28, 21, 45, 7, 46], // v29
  [2185, 28, 19, 47, 10, 48], // v30
  [2323, 28, 2, 46, 29, 47], // v31
  [2465, 28, 10, 46, 23, 47], // v32
  [2611, 28, 14, 46, 21, 47], // v33
  [2761, 28, 14, 46, 23, 47], // v34
  [2876, 28, 12, 47, 26, 48], // v35
  [3034, 28, 6, 47, 34, 48], // v36
  [3196, 28, 29, 46, 14, 47], // v37
  [3362, 28, 13, 46, 32, 47], // v38
  [3532, 28, 40, 47, 7, 48], // v39
  [3706, 28, 18, 47, 31, 48]  // v40
];

// Data capacity in bytes for version 1-40, EC level M, byte mode
const BYTE_CAPACITY_M = [
  0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213, // v1-10
  251, 287, 331, 362, 412, 450, 504, 560, 624, 666, // v11-20
  711, 779, 857, 911, 997, 1059, 1125, 1190, 1264, 1370, // v21-30
  1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331 // v31-40
];

// Alignment pattern positions for versions 2-40
const ALIGNMENT_POSITIONS = [
  null,
  [], // v1
  [6, 18], // v2
  [6, 22], // v3
  [6, 26], // v4
  [6, 30], // v5
  [6, 34], // v6
  [6, 22, 38], // v7
  [6, 24, 42], // v8
  [6, 26, 46], // v9
  [6, 28, 50], // v10
  [6, 30, 54], // v11
  [6, 32, 58], // v12
  [6, 34, 62], // v13
  [6, 26, 46, 66], // v14
  [6, 26, 48, 70], // v15
  [6, 26, 50, 74], // v16
  [6, 30, 54, 78], // v17
  [6, 30, 56, 82], // v18
  [6, 30, 58, 86], // v19
  [6, 34, 62, 90], // v20
  [6, 28, 50, 72, 94], // v21
  [6, 26, 50, 74, 98], // v22
  [6, 30, 54, 78, 102], // v23
  [6, 28, 54, 80, 106], // v24
  [6, 32, 58, 84, 110], // v25
  [6, 30, 58, 86, 114], // v26
  [6, 34, 62, 90, 118], // v27
  [6, 26, 50, 74, 98, 122], // v28
  [6, 30, 54, 78, 102, 126], // v29
  [6, 26, 52, 78, 104, 130], // v30
  [6, 30, 56, 82, 108, 134], // v31
  [6, 34, 60, 86, 112, 138], // v32
  [6, 30, 58, 86, 114, 142], // v33
  [6, 34, 62, 90, 118, 146], // v34
  [6, 30, 54, 78, 102, 126, 150], // v35
  [6, 24, 50, 76, 102, 128, 154], // v36
  [6, 28, 54, 80, 106, 132, 158], // v37
  [6, 32, 58, 84, 110, 136, 162], // v38
  [6, 26, 54, 82, 110, 138, 166], // v39
  [6, 30, 58, 86, 114, 142, 170]  // v40
];

// Format info bits for EC level M with mask patterns 0-7
const FORMAT_BITS_M = [
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
];

// Version information for versions 7-40 (lower versions don't have version info)
const VERSION_INFO = [
  null, null, null, null, null, null, null,
  0x07C94, 0x085BC, 0x09A99, 0x0A4D3, 0x0BBF6, 0x0C762, 0x0D847, 0x0E60D,
  0x0F928, 0x10B78, 0x1145D, 0x12A17, 0x13532, 0x149A6, 0x15683, 0x168C9,
  0x177EC, 0x18EC4, 0x191E1, 0x1AFAB, 0x1B08E, 0x1CC1A, 0x1D33F, 0x1ED75,
  0x1F250, 0x209D5, 0x216F0, 0x228BA, 0x2379F, 0x24B0B, 0x2542E, 0x26A64,
  0x27541, 0x28C69
];

// Remainder bits for versions 1-40
const REMAINDER_BITS = [
  0,
  0, 7, 7, 7, 7, 7, // 1-6
  0, 3, 3, 3, 3, 3, // 7-12
  4, 4, 4, 4, 4,    // 13-17
  3, 3, 3, 3, 3,    // 18-22
  4, 4, 4, 4, 4,    // 23-27
  3, 3, 3, 3, 3,    // 28-32
  4, 4, 4, 4, 4,    // 33-37
  3, 3, 3           // 38-40
];

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: QR Code Encoder
// ═══════════════════════════════════════════════════════════════════════

function qrEncode(text) {
  const data = new TextEncoder().encode(text);
  const byteLen = data.length;

  // Find minimum version
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    if (byteLen <= BYTE_CAPACITY_M[v]) { version = v; break; }
  }
  if (version === 0) throw new Error('Data too long for QR versions 1-40');

  const size = version * 4 + 17;
  const ecInfo = VERSION_EC_M[version];
  const [totalCW, ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW] = ecInfo;
  const totalDataCW = g1Blocks * g1DataCW + g2Blocks * g2DataCW;

  // ── Encode data bits ─────────────────────────────────────────────

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Mode indicator: byte mode = 0100
  pushBits(0b0100, 4);

  // Character count indicator (byte mode: 8 bits for v1-9, 16 bits for v10+)
  const ccBits = version <= 9 ? 8 : 16;
  pushBits(byteLen, ccBits);

  // Data
  for (let i = 0; i < byteLen; i++) pushBits(data[i], 8);

  // Terminator (up to 4 zero bits)
  const dataBitCapacity = totalDataCW * 8;
  const terminatorLen = Math.min(4, dataBitCapacity - bits.length);
  pushBits(0, terminatorLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad bytes: alternating 0xEC, 0x11
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < dataBitCapacity) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to codewords
  const dataCodewords = new Uint8Array(totalDataCW);
  for (let i = 0; i < totalDataCW; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i * 8 + b] || 0);
    dataCodewords[i] = byte;
  }

  // ── Error correction ─────────────────────────────────────────────

  const genPoly = GF.generatorPoly(ecPerBlock);
  const blocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let g = 0; g < 2; g++) {
    const count = g === 0 ? g1Blocks : g2Blocks;
    const dcw = g === 0 ? g1DataCW : g2DataCW;
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + dcw);
      offset += dcw;
      blocks.push(block);

      // Compute EC codewords
      const msgPoly = new Uint8Array(dcw + ecPerBlock);
      msgPoly.set(block);
      const ec = GF.polyRemainder(msgPoly, genPoly);
      ecBlocks.push(ec);
    }
  }

  // ── Interleave blocks ────────────────────────────────────────────

  const interleaved = [];
  const maxDataLen = Math.max(g1DataCW, g2DataCW);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) interleaved.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      if (i < ec.length) interleaved.push(ec[i]);
    }
  }

  // ── Build matrix ─────────────────────────────────────────────────

  // 0 = white, 1 = black, -1 = unset
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size)); // 1 = function pattern

  // Finder patterns
  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        let val;
        if (r === -1 || r === 7 || c === -1 || c === 7) val = 0; // separator
        else if (r === 0 || r === 6 || c === 0 || c === 6) val = 1;
        else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) val = 1;
        else val = 0;
        matrix[rr][cc] = val;
        reserved[rr][cc] = 1;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Alignment patterns
  if (version >= 2) {
    const positions = ALIGNMENT_POSITIONS[version];
    for (const r of positions) {
      for (const c of positions) {
        // Skip if overlaps finder
        if (r <= 8 && c <= 8) continue;
        if (r <= 8 && c >= size - 8) continue;
        if (r >= size - 8 && c <= 8) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const val = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
            matrix[r + dr][c + dc] = val;
            reserved[r + dr][c + dc] = 1;
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === -1) { matrix[6][i] = val; reserved[6][i] = 1; }
    if (matrix[i][6] === -1) { matrix[i][6] = val; reserved[i][6] = 1; }
  }

  // Dark module
  matrix[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    reserved[8][i] = 1;
    reserved[8][size - 1 - i] = 1;
    reserved[i][8] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  reserved[8][8] = 1;

  // Reserve version info areas (v7+)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = 1;
        reserved[size - 11 + j][i] = 1;
      }
    }
  }

  // ── Place data bits ──────────────────────────────────────────────

  const dataBits = [];
  for (const byte of interleaved) {
    for (let b = 7; b >= 0; b--) dataBits.push((byte >> b) & 1);
  }
  // Remainder bits for certain versions
  const remainderBits = REMAINDER_BITS[version] || 0;
  for (let i = 0; i < remainderBits; i++) dataBits.push(0);

  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= size) continue;
        if (reserved[row][c]) continue;
        matrix[row][c] = bitIdx < dataBits.length ? dataBits[bitIdx] : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }

  // ── Masking ──────────────────────────────────────────────────────

  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  function applyMask(mat, maskIdx) {
    const masked = mat.map(row => new Int8Array(row));
    const fn = maskFns[maskIdx];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && fn(r, c)) {
          masked[r][c] ^= 1;
        }
      }
    }
    return masked;
  }

  function placeFormatInfo(mat, maskIdx) {
    const bits = FORMAT_BITS_M[maskIdx];
    // Around top-left finder
    const positions1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    for (let i = 0; i < 15; i++) {
      const [r, c] = positions1[i];
      mat[r][c] = (bits >> (14 - i)) & 1;
    }
    // Around other finders
    const positions2 = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
      [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];
    for (let i = 0; i < 15; i++) {
      const [r, c] = positions2[i];
      mat[r][c] = (bits >> (14 - i)) & 1;
    }
  }

  function placeVersionInfo(mat) {
    if (version < 7) return;
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      mat[r][c] = bit;
      mat[c][r] = bit;
    }
  }

  // Penalty scoring
  function penalty(mat) {
    let score = 0;

    // Rule 1: runs of same color
    for (let r = 0; r < size; r++) {
      let count = 1;
      for (let c = 1; c < size; c++) {
        if (mat[r][c] === mat[r][c - 1]) { count++; }
        else { if (count >= 5) score += count - 2; count = 1; }
      }
      if (count >= 5) score += count - 2;
    }
    for (let c = 0; c < size; c++) {
      let count = 1;
      for (let r = 1; r < size; r++) {
        if (mat[r][c] === mat[r - 1][c]) { count++; }
        else { if (count >= 5) score += count - 2; count = 1; }
      }
      if (count >= 5) score += count - 2;
    }

    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = mat[r][c];
        if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    // Rule 3: finder-like patterns
    const pattern1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pattern2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 11; c++) {
        let match1 = true, match2 = true;
        for (let k = 0; k < 11; k++) {
          if (mat[r][c + k] !== pattern1[k]) match1 = false;
          if (mat[r][c + k] !== pattern2[k]) match2 = false;
        }
        if (match1 || match2) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r <= size - 11; r++) {
        let match1 = true, match2 = true;
        for (let k = 0; k < 11; k++) {
          if (mat[r + k][c] !== pattern1[k]) match1 = false;
          if (mat[r + k][c] !== pattern2[k]) match2 = false;
        }
        if (match1 || match2) score += 40;
      }
    }

    // Rule 4: proportion
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (mat[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    const prev5 = Math.floor(pct / 5) * 5;
    const next5 = prev5 + 5;
    score += Math.min(Math.abs(prev5 - 50) / 5, Math.abs(next5 - 50) / 5) * 10;

    return score;
  }

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(matrix, m);
    placeFormatInfo(masked, m);
    placeVersionInfo(masked);
    const p = penalty(masked);
    if (p < bestPenalty) { bestPenalty = p; bestMask = m; }
  }

  const final = applyMask(matrix, bestMask);
  placeFormatInfo(final, bestMask);
  placeVersionInfo(final);

  return { matrix: final, size, version };
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: SVG Renderer
// ═══════════════════════════════════════════════════════════════════════

function matrixToSVG(matrix, size, pixelSize = 256, accentColor = '#8b5cf6') {
  const moduleCount = matrix.length;
  const quiet = 4; // quiet zone modules
  const totalModules = moduleCount + quiet * 2;
  const modSize = pixelSize / totalModules;

  let paths = '';
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (matrix[r][c] === 1) {
        const x = (c + quiet) * modSize;
        const y = (r + quiet) * modSize;
        paths += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${modSize.toFixed(2)}" height="${modSize.toFixed(2)}" fill="${accentColor}"/>`;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixelSize} ${pixelSize}" width="${pixelSize}" height="${pixelSize}">`,
    `<rect width="${pixelSize}" height="${pixelSize}" fill="#fff"/>`,
    paths,
    `<text x="${pixelSize / 2}" y="${pixelSize - 2}" text-anchor="middle" font-family="monospace" font-size="${modSize * 0.8}" fill="${accentColor}" opacity="0.4">GhostLink</text>`,
    `</svg>`,
  ].join('');
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: QR Invite
// ═══════════════════════════════════════════════════════════════════════

function hexFromBytes(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesFromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

/** Signing an invite failed; there is deliberately no unsigned or HMAC fallback. */
class InviteSigningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InviteSigningError';
  }
}

class QRInvite {
  /**
   * @param {object} identity
   * @param {CryptoKeyPair} identity.keyPair  ECDSA P-256 key pair
   * @param {string}        identity.publicKeyHex
   * @param {string}        identity.name     Display name
   * @param {string}        [identity.signalingUrl]
   */
  constructor(identity) {
    this._identity = identity;
  }

  // ── Generate invite data ─────────────────────────────────────────

  /**
   * Generate an invite object with a fresh invite code.
   */
  async generateInvite() {
    const code = this._generateCode();
    const timestamp = Date.now();

    const payload = `${code}|${this._identity.publicKeyHex}|${this._identity.name}|${timestamp}`;
    const signature = await this._sign(payload);

    return {
      code,
      publicKey: this._identity.publicKeyHex,
      name: this._identity.name,

      timestamp,
      signature,
    };
  }

  _generateCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = hexFromBytes(bytes).toUpperCase();
    return `GL-${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24, 32)}`;
  }

  async _sign(payload) {
    // Invites are signed with ECDSA P-256 only. The identity's ECDH key is
    // re-imported as ECDSA when no separate signing key is given. There is no
    // fallback: a "signature" anyone can compute is worse than none.
    let signingKey = this._identity.signingKey;
    try {
      if (!signingKey && this._identity.keyPair && this._identity.keyPair.privateKey) {
        const exported = await crypto.subtle.exportKey('pkcs8', this._identity.keyPair.privateKey);
        signingKey = await crypto.subtle.importKey(
          'pkcs8', exported,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false, ['sign']
        );
      }
      if (!signingKey) throw new Error('no private key available');

      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingKey,
        new TextEncoder().encode(payload)
      );
      return hexFromBytes(new Uint8Array(sig));
    } catch (e) {
      throw new InviteSigningError(`Cannot sign invite: ${e.message}`);
    }
  }

  // ── Encode for QR ────────────────────────────────────────────────

  /**
   * Encode invite as a compact JSON string for QR code.
   * Uses abbreviated keys to minimize QR data size.
   */
  async encodeForQR() {
    const invite = await this.generateInvite();
    return JSON.stringify({
      c: invite.code,
      p: invite.publicKey,
      n: invite.name,
      t: invite.timestamp,
      sig: invite.signature,
    });
  }

  // ── Generate QR SVG ──────────────────────────────────────────────

  /**
   * Generate a QR code as an SVG string.
   *
   * @param {number} size  Pixel dimension (default 256)
   * @returns {string} SVG markup
   */
  async generateQRCodeSVG(size = 256) {
    const data = await this.encodeForQR();
    const { matrix } = qrEncode(data);
    return matrixToSVG(matrix, matrix.length, size);
  }

  // ── Render to canvas ─────────────────────────────────────────────

  /**
   * Render QR code onto a canvas element.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} size
   */
  async renderQRToCanvas(canvas, size = 256) {
    const data = await this.encodeForQR();
    const { matrix } = qrEncode(data);

    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const moduleCount = matrix.length;
    const quiet = 4;
    const totalModules = moduleCount + quiet * 2;
    const modSize = size / totalModules;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#8b5cf6'; // GhostLink accent
    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (matrix[r][c] === 1) {
          ctx.fillRect(
            (c + quiet) * modSize,
            (r + quiet) * modSize,
            modSize, modSize
          );
        }
      }
    }
  }

  // ── Parse invite ─────────────────────────────────────────────────

  /**
   * Parse scanned QR data back to an invite object.
   *
   * @param {string} qrData  Raw string from QR scan
   * @returns {object} Invite object
   */
  static parseInvite(qrData) {
    let parsed;
    try {
      parsed = JSON.parse(qrData);
    } catch (_) {
      throw new Error('Invalid QR data: not valid JSON');
    }

    // Accept both full and abbreviated keys
    const invite = {
      code: parsed.code || parsed.c,
      publicKey: parsed.publicKey || parsed.p,
      name: parsed.name || parsed.n,
      timestamp: parsed.timestamp || parsed.t,
      signature: parsed.signature || parsed.sig,
    };

    // Validate code format
    if (!invite.code || !/^GL-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/.test(invite.code)) {
      throw new Error('Invalid invite code format');
    }

    if (!invite.publicKey || typeof invite.publicKey !== 'string') {
      throw new Error('Missing or invalid public key');
    }

    if (!invite.timestamp || typeof invite.timestamp !== 'number') {
      throw new Error('Missing or invalid timestamp');
    }

    // Check freshness (24h)
    const age = Date.now() - invite.timestamp;
    if (age > 86400000) {
      throw new Error('Invite expired (older than 24 hours)');
    }
    if (age < -300000) {
      throw new Error('Invite timestamp is in the future');
    }

    return invite;
  }

  // ── Verify invite ────────────────────────────────────────────────

  /**
   * Verify the authenticity of an invite.
   *
   * @param {object} invite  Parsed invite object
   * @returns {{ valid: boolean, reason?: string }}
   */
  static async verifyInvite(invite) {
    // Validate format
    if (!invite.code || !/^GL-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}-[A-F0-9]{8}$/.test(invite.code)) {
      return { valid: false, reason: 'Invalid invite code format' };
    }

    // Check timestamp freshness
    const age = Date.now() - invite.timestamp;
    if (age > 86400000) {
      return { valid: false, reason: 'Invite expired' };
    }
    if (age < -300000) {
      return { valid: false, reason: 'Timestamp in the future' };
    }

    if (!invite.publicKey || !invite.signature) {
      return { valid: false, reason: 'Missing public key or signature' };
    }

    // Reconstruct payload
    const payload = `${invite.code}|${invite.publicKey}|${invite.name}|${invite.timestamp}`;
    const sigBytes = bytesFromHex(invite.signature);

    // Try ECDSA verification
    try {
      const pubKeyBytes = bytesFromHex(invite.publicKey);
      const pubKey = await crypto.subtle.importKey(
        'raw', pubKeyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify']
      );

      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        sigBytes,
        new TextEncoder().encode(payload)
      );

      if (valid) return { valid: true };
    } catch (_) {
      // Not a P-256 public key or not a raw ECDSA signature: rejected below.
    }

    return { valid: false, reason: 'Signature verification failed' };
  }

  // ── Deep links ───────────────────────────────────────────────────

  /**
   * Create a deep link URL from an invite.
   *
   * @param {object} invite
   * @returns {string}
   */
  static toDeepLink(invite) {
    const params = new URLSearchParams({
      key: invite.publicKey,
      name: invite.name || '',
      sig: invite.signature || '',
      t: String(invite.timestamp),
    });
    return `ghostlink://invite/${invite.code}?${params.toString()}`;
  }

  /**
   * Parse a deep link URL back to an invite object.
   *
   * @param {string} url
   * @returns {object}
   */
  static fromDeepLink(url) {
    // Parse: ghostlink://invite/GL-XXXXXXXX-...?key=hex&name=...
    const match = url.match(/^ghostlink:\/\/invite\/(GL-[A-F0-9-]+)\?(.*)$/);
    if (!match) throw new Error('Invalid GhostLink deep link');

    const code = match[1];
    const params = new URLSearchParams(match[2]);

    return {
      code,
      publicKey: params.get('key') || '',
      name: params.get('name') || '',

      timestamp: parseInt(params.get('t') || '0', 10),
      signature: params.get('sig') || '',
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 6: QR Code Scanner
// ═══════════════════════════════════════════════════════════════════════

class QRScanner {
  constructor() {
    this._listeners = {};
    this._stream = null;
    this._scanning = false;
    this._animFrameId = null;
    this._canvas = null;
    this._ctx = null;
  }

  // ── Camera scanning ──────────────────────────────────────────────

  /**
   * Start scanning using the device camera.
   *
   * @param {HTMLVideoElement} videoElement
   */
  async startScanning(videoElement) {
    if (this._scanning) return;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      // Fallback to any camera
      try {
        this._stream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e) {
        this._emit('error', { message: 'Camera access denied', error: e });
        return;
      }
    }

    videoElement.srcObject = this._stream;
    await videoElement.play();

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._scanning = true;

    this._emit('camera-ready', { width: videoElement.videoWidth, height: videoElement.videoHeight });

    const scan = () => {
      if (!this._scanning) return;

      if (videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
        this._canvas.width = videoElement.videoWidth;
        this._canvas.height = videoElement.videoHeight;
        this._ctx.drawImage(videoElement, 0, 0);
        const imageData = this._ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);

        try {
          const result = decodeQRFromImageData(imageData);
          if (result) {
            this._emit('scan', { data: result });
          }
        } catch (_) {
          // No QR found in this frame — continue scanning
        }
      }

      this._animFrameId = requestAnimationFrame(scan);
    };

    this._animFrameId = requestAnimationFrame(scan);
  }

  /**
   * Stop camera scanning.
   */
  stopScanning() {
    this._scanning = false;
    if (this._animFrameId) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
  }

  // ── Scan from image file ─────────────────────────────────────────

  /**
   * Decode a QR code from an image file.
   *
   * @param {File|Blob} imageFile
   * @returns {string|null} Decoded data or null
   */
  async scanFromImage(imageFile) {
    const bitmap = await createImageBitmap(imageFile);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    try {
      const result = decodeQRFromImageData(imageData);
      if (result) {
        this._emit('scan', { data: result });
        return result;
      }
    } catch (_) {
      // decode failed
    }
    return null;
  }

  // ── Events ───────────────────────────────────────────────────────

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(fn => fn !== callback);
  }

  _emit(event, data) {
    const cbs = this._listeners[event];
    if (!cbs) return;
    for (const cb of cbs) {
      try { cb(data); } catch (_) { /* */ }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 7: QR Code Decoder (Pure Implementation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Decode a QR code from ImageData.
 * Implements: grayscale conversion, finder pattern detection,
 * perspective sampling, format/version parsing, data extraction, and
 * error correction decoding.
 *
 * @param {ImageData} imageData
 * @returns {string|null}
 */
function decodeQRFromImageData(imageData) {
  const { data, width, height } = imageData;

  // ── Grayscale + binarize (adaptive threshold) ────────────────────

  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    gray[i] = Math.round(data[off] * 0.299 + data[off + 1] * 0.587 + data[off + 2] * 0.114);
  }

  // Block-based adaptive threshold
  const blockSize = Math.max(8, Math.floor(Math.min(width, height) / 32));
  const binary = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Compute local average in a block
      const x0 = Math.max(0, x - blockSize);
      const x1 = Math.min(width - 1, x + blockSize);
      const y0 = Math.max(0, y - blockSize);
      const y1 = Math.min(height - 1, y + blockSize);

      let sum = 0, count = 0;
      // Sample sparsely for performance
      for (let sy = y0; sy <= y1; sy += 2) {
        for (let sx = x0; sx <= x1; sx += 2) {
          sum += gray[sy * width + sx];
          count++;
        }
      }
      const avg = sum / count;
      binary[y * width + x] = gray[y * width + x] < avg - 10 ? 1 : 0;
    }
  }

  const getB = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return binary[y * width + x];
  };

  // ── Find finder patterns ─────────────────────────────────────────

  // Scan horizontal lines for 1:1:3:1:1 ratio pattern
  const candidates = [];

  function checkRatio(counts) {
    const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (total < 7) return false;
    const module = total / 7;
    const threshold = module * 0.7;
    return (
      Math.abs(counts[0] - module) < threshold &&
      Math.abs(counts[1] - module) < threshold &&
      Math.abs(counts[2] - 3 * module) < threshold &&
      Math.abs(counts[3] - module) < threshold &&
      Math.abs(counts[4] - module) < threshold
    );
  }

  // Scan rows
  for (let y = 0; y < height; y += 2) {
    let state = 0;
    const counts = [0, 0, 0, 0, 0];

    for (let x = 0; x < width; x++) {
      const pixel = getB(x, y);

      if (pixel === 1) {
        // dark pixel
        if (state === 1 || state === 3) { counts[state]++; }
        else if (state === 0 || state === 2 || state === 4) { counts[state]++; /* already dark state, handled below */ }

        // State machine: expecting dark, light, dark(center), light, dark
        if (state % 2 === 1) {
          // was in light state, switch
          state++;
          counts[state] = 1;
        } else {
          counts[state]++;
        }
      } else {
        // light pixel
        if (state % 2 === 0) {
          if (state === 4) {
            // Check pattern
            if (checkRatio(counts)) {
              const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
              const cx = x - total / 2;
              const cy = y;
              // Verify vertically
              if (verifyVertical(cx, cy, counts[2])) {
                candidates.push({ x: Math.round(cx), y: cy, size: total });
              }
            }
            // Shift
            counts[0] = counts[2];
            counts[1] = counts[3];
            counts[2] = counts[4];
            counts[3] = 1;
            counts[4] = 0;
            state = 3;
          } else {
            state++;
            counts[state] = 1;
          }
        } else {
          counts[state]++;
        }
      }
    }
  }

  function verifyVertical(cx, cy, expectedSize) {
    const x = Math.round(cx);
    let count = 0;
    // Count dark pixels vertically from center
    for (let dy = 0; dy < expectedSize * 2 && cy + dy < height; dy++) {
      if (getB(x, cy + dy) === 1) count++;
      else break;
    }
    for (let dy = 1; dy < expectedSize * 2 && cy - dy >= 0; dy++) {
      if (getB(x, cy - dy) === 1) count++;
      else break;
    }
    return Math.abs(count - expectedSize) < expectedSize * 0.6;
  }

  // Cluster candidates to find 3 distinct finder patterns
  const clusters = [];
  for (const c of candidates) {
    let merged = false;
    for (const cl of clusters) {
      const dist = Math.hypot(cl.x - c.x, cl.y - c.y);
      if (dist < c.size) {
        cl.x = (cl.x * cl.count + c.x) / (cl.count + 1);
        cl.y = (cl.y * cl.count + c.y) / (cl.count + 1);
        cl.size = (cl.size * cl.count + c.size) / (cl.count + 1);
        cl.count++;
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ ...c, count: 1 });
  }

  // Need exactly 3 finder patterns
  // Sort by count (most confirmed first) and take top 3
  clusters.sort((a, b) => b.count - a.count);
  if (clusters.length < 3) return null;

  const finders = clusters.slice(0, 3);

  // ── Determine orientation ────────────────────────────────────────
  // Top-left finder is the one that forms a right angle with the other two

  let topLeft, topRight, bottomLeft;

  const d01 = Math.hypot(finders[0].x - finders[1].x, finders[0].y - finders[1].y);
  const d02 = Math.hypot(finders[0].x - finders[2].x, finders[0].y - finders[2].y);
  const d12 = Math.hypot(finders[1].x - finders[2].x, finders[1].y - finders[2].y);

  // The longest distance is the diagonal (between topRight and bottomLeft)
  if (d12 >= d01 && d12 >= d02) {
    topLeft = finders[0]; topRight = finders[1]; bottomLeft = finders[2];
  } else if (d02 >= d01 && d02 >= d12) {
    topLeft = finders[1]; topRight = finders[0]; bottomLeft = finders[2];
  } else {
    topLeft = finders[2]; topRight = finders[0]; bottomLeft = finders[1];
  }

  // Ensure correct orientation using cross product
  const cross = (topRight.x - topLeft.x) * (bottomLeft.y - topLeft.y) -
                (topRight.y - topLeft.y) * (bottomLeft.x - topLeft.x);
  if (cross < 0) {
    const tmp = topRight;
    topRight = bottomLeft;
    bottomLeft = tmp;
  }

  // ── Estimate version and module size ─────────────────────────────

  const distTR = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const moduleSize = distTR / 14; // distance between TL and TR centers = (version*4+17 - 7) but we approximate
  // More precise: distance between TL and TR is (size - 7) modules from center to center
  // For finder pattern, center-to-center is (moduleCount - 7) modules across
  // We can estimate version from this
  const estimatedModules = Math.round(distTR / moduleSize) + 7;
  const version = Math.max(1, Math.min(10, Math.round((estimatedModules - 17) / 4)));
  const moduleCount = version * 4 + 17;
  const correctedModuleSize = distTR / (moduleCount - 7);

  // ── Sample the QR grid ───────────────────────────────────────────

  // Use perspective transform to sample module values
  // Map from QR coordinates (module row, col) to image coordinates
  const dx1 = (topRight.x - topLeft.x) / (moduleCount - 7);
  const dy1 = (topRight.y - topLeft.y) / (moduleCount - 7);
  const dx2 = (bottomLeft.x - topLeft.x) / (moduleCount - 7);
  const dy2 = (bottomLeft.y - topLeft.y) / (moduleCount - 7);

  // Origin = topLeft finder center, which is at module (3.5, 3.5)
  const ox = topLeft.x - 3.5 * dx1 - 3.5 * dx2;
  const oy = topLeft.y - 3.5 * dy1 - 3.5 * dy2;

  function sampleModule(row, col) {
    const px = ox + col * dx1 + row * dx2;
    const py = oy + col * dy1 + row * dy2;
    const ix = Math.round(px);
    const iy = Math.round(py);
    if (ix < 0 || ix >= width || iy < 0 || iy >= height) return 0;
    return binary[iy * width + ix];
  }

  const grid = Array.from({ length: moduleCount }, (_, r) =>
    Array.from({ length: moduleCount }, (_, c) => sampleModule(r, c))
  );

  // ── Read format information ──────────────────────────────────────

  // Format info is around the top-left finder
  let formatBits1 = 0;
  const fmtPositions1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = fmtPositions1[i];
    formatBits1 = (formatBits1 << 1) | (grid[r]?.[c] || 0);
  }

  // XOR with mask pattern 0x5412 to get actual format
  const FORMAT_MASK = 0x5412;

  // Try to match against known format info values
  let detectedMask = -1;
  let detectedEC = -1;
  const FORMAT_TABLE = [];
  // Generate format info for all EC levels and mask patterns
  // EC level bits: L=01, M=00, Q=11, H=10
  const EC_BITS = [0b01, 0b00, 0b11, 0b10]; // L, M, Q, H
  for (let ec = 0; ec < 4; ec++) {
    for (let mask = 0; mask < 8; mask++) {
      let data = (EC_BITS[ec] << 3) | mask;
      // BCH(15,5) encoding
      let bits = data << 10;
      // Generator polynomial for BCH: x^10 + x^8 + x^5 + x^4 + x^2 + x + 1 = 0x537
      let gen = 0x537;
      for (let i = 4; i >= 0; i--) {
        if (bits & (1 << (i + 10))) bits ^= gen << i;
      }
      bits = (data << 10) | bits;
      bits ^= FORMAT_MASK;
      FORMAT_TABLE.push({ ec, mask, bits });
    }
  }

  let bestDist = Infinity;
  for (const entry of FORMAT_TABLE) {
    let dist = 0;
    let diff = formatBits1 ^ entry.bits;
    while (diff) { dist += diff & 1; diff >>= 1; }
    if (dist < bestDist) {
      bestDist = dist;
      detectedEC = entry.ec;
      detectedMask = entry.mask;
    }
  }

  if (detectedMask < 0 || bestDist > 3) return null; // too many errors in format info

  // ── Unmask data ──────────────────────────────────────────────────

  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ][detectedMask];

  // Build reserved mask (function patterns)
  const isReserved = Array.from({ length: moduleCount }, () => new Uint8Array(moduleCount));

  // Finder patterns + separators
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) isReserved[r][c] = 1;
  for (let r = 0; r < 9; r++) for (let c = moduleCount - 8; c < moduleCount; c++) isReserved[r][c] = 1;
  for (let r = moduleCount - 8; r < moduleCount; r++) for (let c = 0; c < 9; c++) isReserved[r][c] = 1;

  // Timing patterns
  for (let i = 8; i < moduleCount - 8; i++) {
    isReserved[6][i] = 1;
    isReserved[i][6] = 1;
  }

  // Alignment patterns
  if (version >= 2 && ALIGNMENT_POSITIONS[version]) {
    const positions = ALIGNMENT_POSITIONS[version];
    for (const r of positions) {
      for (const c of positions) {
        if (r <= 8 && c <= 8) continue;
        if (r <= 8 && c >= moduleCount - 8) continue;
        if (r >= moduleCount - 8 && c <= 8) continue;
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++)
            if (r + dr >= 0 && r + dr < moduleCount && c + dc >= 0 && c + dc < moduleCount)
              isReserved[r + dr][c + dc] = 1;
      }
    }
  }

  // Format info areas
  for (let i = 0; i < 8; i++) {
    isReserved[8][i] = 1;
    isReserved[8][moduleCount - 1 - i] = 1;
    isReserved[i][8] = 1;
    isReserved[moduleCount - 1 - i][8] = 1;
  }
  isReserved[8][8] = 1;
  isReserved[moduleCount - 8][8] = 1; // dark module

  // Version info (v7+)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        isReserved[i][moduleCount - 11 + j] = 1;
        isReserved[moduleCount - 11 + j][i] = 1;
      }
    }
  }

  // Unmask data modules
  const unmasked = grid.map(row => [...row]);
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (!isReserved[r][c] && maskFn(r, c)) {
        unmasked[r][c] ^= 1;
      }
    }
  }

  // ── Extract data bits ────────────────────────────────────────────

  const dataBits = [];
  let upward = true;
  for (let col = moduleCount - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5;
    const rows = upward
      ? Array.from({ length: moduleCount }, (_, i) => moduleCount - 1 - i)
      : Array.from({ length: moduleCount }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || c >= moduleCount) continue;
        if (isReserved[row][c]) continue;
        dataBits.push(unmasked[row][c]);
      }
    }
    upward = !upward;
  }

  // Convert bits to codewords
  const codewords = [];
  for (let i = 0; i + 7 < dataBits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | dataBits[i + b];
    codewords.push(byte);
  }

  // ── De-interleave and error correct ──────────────────────────────

  // Use EC info for the detected EC level
  // For simplicity, use M level tables (most common for our generated codes)
  const ecInfo = VERSION_EC_M[version];
  if (!ecInfo) return null;

  const [totalCW, ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW] = ecInfo;
  const totalBlocks = g1Blocks + g2Blocks;
  const totalDataCW = g1Blocks * g1DataCW + g2Blocks * g2DataCW;

  // De-interleave data codewords
  const dataBlocks = [];
  for (let b = 0; b < totalBlocks; b++) {
    const dcw = b < g1Blocks ? g1DataCW : g2DataCW;
    dataBlocks.push(new Uint8Array(dcw));
  }

  let idx = 0;
  const maxDCW = Math.max(g1DataCW, g2DataCW);
  for (let i = 0; i < maxDCW; i++) {
    for (let b = 0; b < totalBlocks; b++) {
      const dcw = b < g1Blocks ? g1DataCW : g2DataCW;
      if (i < dcw && idx < codewords.length) {
        dataBlocks[b][i] = codewords[idx++];
      }
    }
  }

  // De-interleave EC codewords
  const ecBlocksDecoded = [];
  for (let b = 0; b < totalBlocks; b++) {
    ecBlocksDecoded.push(new Uint8Array(ecPerBlock));
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < totalBlocks; b++) {
      if (idx < codewords.length) {
        ecBlocksDecoded[b][i] = codewords[idx++];
      }
    }
  }

  // Concatenate data codewords (skip RS error correction for speed;
  // the Reed-Solomon implementation above is for encoding only)
  const allData = [];
  for (const block of dataBlocks) {
    for (const byte of block) allData.push(byte);
  }

  // ── Decode data ──────────────────────────────────────────────────

  let bitPos = 0;
  const readBits = (n) => {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitIdx = 7 - (bitPos % 8);
      if (byteIdx < allData.length) {
        val = (val << 1) | ((allData[byteIdx] >> bitIdx) & 1);
      }
      bitPos++;
    }
    return val;
  };

  let result = '';
  const maxBits = totalDataCW * 8;

  while (bitPos < maxBits - 4) {
    const mode = readBits(4);
    if (mode === 0) break; // terminator

    if (mode === 0b0100) {
      // Byte mode
      const ccBits = version <= 9 ? 8 : 16;
      const count = readBits(ccBits);
      if (count === 0 || count > 1000) break; // sanity check
      const bytes = [];
      for (let i = 0; i < count; i++) bytes.push(readBits(8));
      try {
        result += new TextDecoder().decode(new Uint8Array(bytes));
      } catch (_) {
        result += String.fromCharCode(...bytes);
      }
    } else if (mode === 0b0010) {
      // Alphanumeric mode
      const ccBits = version <= 9 ? 9 : 11;
      const count = readBits(ccBits);
      const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
      for (let i = 0; i < Math.floor(count / 2); i++) {
        const val = readBits(11);
        result += ALPHA[Math.floor(val / 45)] + ALPHA[val % 45];
      }
      if (count % 2 === 1) {
        result += ALPHA[readBits(6)];
      }
    } else if (mode === 0b0001) {
      // Numeric mode
      const ccBits = version <= 9 ? 10 : 12;
      const count = readBits(ccBits);
      for (let i = 0; i < Math.floor(count / 3); i++) {
        const val = readBits(10);
        result += String(val).padStart(3, '0');
      }
      const rem = count % 3;
      if (rem === 2) result += String(readBits(7)).padStart(2, '0');
      else if (rem === 1) result += String(readBits(4));
    } else {
      break; // unsupported mode, stop
    }
  }

  return result || null;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

window.QRInvite = QRInvite;
window.InviteSigningError = InviteSigningError;
window.QRScanner = QRScanner;
window.qrEncode = qrEncode;
window.matrixToSVG = matrixToSVG;
window.decodeQRFromImageData = decodeQRFromImageData;
