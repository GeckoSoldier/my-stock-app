/* ==========================================================================
   qrcode.js - 外部サービスに頼らずにQRコードを作る小さなライブラリ
   ・バイトモード（UTF-8）/ 誤り訂正レベル L・M・Q・H / バージョン1〜40に対応
   ・QRコードの規格（ISO/IEC 18004）に沿った一般的なアルゴリズムで実装しています。
     構成は Project Nayuki "QR Code generator library"（MIT License）を参考にしています。
   使い方:
     QRMini.toSvg("https://example.com", { ecl: "M", border: 4 })  // SVG文字列を返す
     QRMini.encode("text", "M")  // { size, modules: boolean[][] } を返す
   ========================================================================== */
(function (global) {
  "use strict";

  // 誤り訂正レベルごと・バージョンごとの、1ブロックあたりの誤り訂正コード語数
  const ECC_CODEWORDS_PER_BLOCK = [
    // 0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
    [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]  // H
  ];

  // 誤り訂正レベルごと・バージョンごとの、ブロック数
  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,  4,  4,  4,  4,  6,  6,  6,  6,  7,  8,  8,  9,  9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,  5,  8,  9,  9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8,  8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]  // H
  ];

  const ECL = {
    L: { ordinal: 0, formatBits: 1 },
    M: { ordinal: 1, formatBits: 0 },
    Q: { ordinal: 2, formatBits: 3 },
    H: { ordinal: 3, formatBits: 2 }
  };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  }

  /* ---------- Reed-Solomon（GF(2^8), 原始多項式 0x11D） ---------- */
  function rsMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsComputeDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }

  function rsComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      for (let i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
    }
    return result;
  }

  function toUtf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    const s = unescape(encodeURIComponent(text));
    const out = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  /* ---------- 本体 ---------- */
  function encode(text, eclName, forceMask) {
    const bytes = toUtf8Bytes(String(text));
    let ecl = ECL[eclName] || ECL.M;

    // 入るバージョンを探す
    let ver;
    let dataUsedBits;
    for (ver = 1; ; ver++) {
      const capacityBits = getNumDataCodewords(ver, ecl) * 8;
      const usedBits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (usedBits <= capacityBits) { dataUsedBits = usedBits; break; }
      if (ver >= 40) throw new RangeError("QRコードに入りきらない長さです");
    }
    // 同じバージョンで入るなら、誤り訂正レベルを上げて読み取りやすくする
    for (const e of [ECL.M, ECL.Q, ECL.H]) {
      if (e.ordinal > ecl.ordinal && dataUsedBits <= getNumDataCodewords(ver, e) * 8) ecl = e;
    }

    // データのビット列を作る
    const bits = [];
    const appendBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    appendBits(0x4, 4);                                  // バイトモード
    appendBits(bytes.length, ver < 10 ? 8 : 16);         // 文字数
    bytes.forEach((b) => appendBits(b, 8));
    const capacityBits = getNumDataCodewords(ver, ecl) * 8;
    appendBits(0, Math.min(4, capacityBits - bits.length)); // 終端
    appendBits(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);

    const dataCodewords = new Array(bits.length / 8).fill(0);
    bits.forEach((b, i) => { dataCodewords[i >>> 3] |= b << (7 - (i & 7)); });

    // 誤り訂正コードを付けてインターリーブ
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const rsDiv = rsComputeDivisor(blockEccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const allCodewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) allCodewords.push(blocks[j][i]);
      }
    }

    // 模様を描く
    const size = ver * 4 + 17;
    const modules = [];
    const isFunction = [];
    for (let i = 0; i < size; i++) {
      modules.push(new Array(size).fill(false));
      isFunction.push(new Array(size).fill(false));
    }
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

    // タイミングパターン
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    // ファインダーパターン（3隅の四角）
    const drawFinder = (x, y) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // アライメントパターン
    const alignPos = (() => {
      if (ver === 1) return [];
      const numAlign = Math.floor(ver / 7) + 2;
      const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
      const result = [6];
      for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
      return result;
    })();
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFn(alignPos[i] + dx, alignPos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // 形式情報
    const drawFormatBits = (mask) => {
      const data = (ecl.formatBits << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const fbits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fbits, i));
      setFn(8, 7, getBit(fbits, 6));
      setFn(8, 8, getBit(fbits, 7));
      setFn(7, 8, getBit(fbits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(fbits, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(fbits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(fbits, i));
      setFn(8, size - 8, true);
    };
    drawFormatBits(0); // 位置を予約するための仮描画

    // 型番情報（バージョン7以上）
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const vbits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = getBit(vbits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, dark);
        setFn(b, a, dark);
      }
    }

    // データを配置（右下からジグザグ）
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && bitIndex < allCodewords.length * 8) {
            modules[y][x] = getBit(allCodewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    // マスク
    const applyMask = (mask) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (isFunction[y][x]) continue;
          let invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
            case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
            default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          }
          if (invert) modules[y][x] = !modules[y][x];
        }
      }
    };

    const penalty = () => {
      let score = 0;
      const get = (x, y) => modules[y][x];
      // 同じ色が5つ以上並ぶ
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
          let run = 0;
          let prev = null;
          for (let b = 0; b < size; b++) {
            const c = pass === 0 ? get(b, a) : get(a, b);
            if (c === prev) {
              run++;
              if (run === 5) score += 3;
              else if (run > 5) score += 1;
            } else { prev = c; run = 1; }
          }
        }
      }
      // 2x2 の同色ブロック
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = get(x, y);
          if (c === get(x + 1, y) && c === get(x, y + 1) && c === get(x + 1, y + 1)) score += 3;
        }
      }
      // ファインダーに似た模様
      const pats = [
        [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
        [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
      ];
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
          for (let b = 0; b + 11 <= size; b++) {
            for (const p of pats) {
              let match = true;
              for (let k = 0; k < 11 && match; k++) {
                const c = pass === 0 ? get(b + k, a) : get(a, b + k);
                if ((c ? 1 : 0) !== p[k]) match = false;
              }
              if (match) score += 40;
            }
          }
        }
      }
      // 黒と白のバランス
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (get(x, y)) dark++;
      const total = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
      score += Math.max(0, k) * 10;
      return score;
    };

    let bestMask = 0;
    if (typeof forceMask === "number" && forceMask >= 0 && forceMask <= 7) {
      bestMask = forceMask;
    } else {
      let minPenalty = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m);
        drawFormatBits(m);
        const p = penalty();
        if (p < minPenalty) { minPenalty = p; bestMask = m; }
        applyMask(m); // 元に戻す（XORなので2回で戻る）
      }
    }
    applyMask(bestMask);
    drawFormatBits(bestMask);

    return { size, version: ver, ecl: Object.keys(ECL).find((k2) => ECL[k2] === ecl), mask: bestMask, modules };
  }

  function toSvg(text, options) {
    const opts = options || {};
    const border = opts.border === undefined ? 4 : opts.border;
    const qr = encode(text, opts.ecl || "M");
    const dim = qr.size + border * 2;
    const parts = [];
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QRコード">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>` +
      `<path d="${parts.join("")}" fill="#000000"/></svg>`;
  }

  const api = { encode, toSvg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.QRMini = api;
})(typeof window !== "undefined" ? window : globalThis);
