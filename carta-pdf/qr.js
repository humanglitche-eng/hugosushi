'use strict';
/* QR propio, sin librerías — porque una entrada tiene que poder viajar por
   WhatsApp y validarse en la puerta sin depender de un CDN.

   Alcance a propósito: modo byte, corrección M, versiones 1 a 13 (hasta ~331
   caracteres — un código de entrada usa ~30; el QR fiscal de ARCA, ~250).
   La máscara se elige probando
   las ocho con la penalización de corridas, que es la que más pesa en la
   práctica. Verificado contra el decodificador nativo del navegador
   (BarcodeDetector): lo que este archivo pinta, ese lo lee.

   Uso:  QR.pintar(canvas, 'texto', escala)  →  true si lo pudo codificar. */
(function () {

  /* ── GF(256), polinomio 0x11d — la aritmética de Reed-Solomon ─────────── */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

  // Polinomio generador de grado n: (x-α^0)(x-α^1)...(x-α^(n-1))
  function generador(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= mul(g[j], EXP[i]);
        ng[j + 1] ^= g[j];
      }
      g = ng;
    }
    return g;
  }

  function restoRS(datos, nEC) {
    // `generador` devuelve coeficientes en orden ASCENDENTE (g[k] = coef de
    // x^k); la división sintética consume el polinomio de mayor a menor, así
    // que acá se lee al revés — g[nEC] es el 1 líder y no entra.
    const g = generador(nEC);
    const r = new Array(nEC).fill(0);
    for (const d of datos) {
      const f = d ^ r[0];
      r.shift(); r.push(0);
      if (f) for (let j = 0; j < nEC; j++) r[j] ^= mul(g[nEC - 1 - j], f);
    }
    return r;
  }

  /* ── Capacidades, nivel M: [EC por bloque, [bloques, datos c/u], …] ───── */
  // Desde v7 los bloques vienen en DOS grupos y los del segundo llevan un
  // byte más — tabla del estándar ISO 18004, nivel M. Se extendió hasta v13
  // (~331 bytes) para que entre el QR fiscal de ARCA (RG 4892, ~250).
  const CAP = {
    1:  [10, [1, 16]],           2:  [16, [1, 28]],
    3:  [26, [1, 44]],           4:  [18, [2, 32]],
    5:  [24, [2, 43]],           6:  [16, [4, 27]],
    7:  [18, [4, 31]],           8:  [22, [2, 38], [2, 39]],
    9:  [22, [3, 36], [2, 37]],  10: [26, [4, 43], [1, 44]],
    11: [30, [1, 50], [4, 51]],  12: [22, [6, 36], [2, 37]],
    13: [22, [8, 37], [1, 38]],
  };
  const ALINEA = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  };
  const totalDe = (v) => CAP[v].slice(1).reduce((a, [n, d]) => a + n * d, 0);

  function codificar(texto) {
    const bytes = new TextEncoder().encode(texto);
    let v = 0;
    for (let i = 1; i <= 13; i++) {
      // El largo ocupa 8 bits hasta v9 y 16 desde v10: el encabezado pasa de
      // 12 a 20 bits, o sea de 2 a 3 bytes redondeando con el terminador.
      const encabezado = i >= 10 ? 3 : 2;
      if (bytes.length + encabezado <= totalDe(i)) { v = i; break; }
    }
    if (!v) return null;
    const total = totalDe(v);
    const nEC = CAP[v][0];

    // flujo de bits: modo 0100 + largo + datos + terminador
    const bits = [];
    const meter = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    meter(0b0100, 4);
    meter(bytes.length, v >= 10 ? 16 : 8);
    for (const b of bytes) meter(b, 8);
    meter(0, Math.min(4, total * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const datos = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      datos.push(b);
    }
    for (let p = 0; datos.length < total; p ^= 1) datos.push(p ? 0x11 : 0xec);

    // bloques (grupos de tamaño desigual) + EC, y el entrelazado del estándar:
    // byte a byte entre bloques — los cortos simplemente se quedan sin byte
    // en la última vuelta.
    const bloques = [], ecs = [];
    let corte = 0;
    for (const [n, d] of CAP[v].slice(1)) {
      for (let b = 0; b < n; b++) {
        const bl = datos.slice(corte, corte + d);
        corte += d;
        bloques.push(bl); ecs.push(restoRS(bl, nEC));
      }
    }
    const masLargo = Math.max(...bloques.map((b) => b.length));
    const flujo = [];
    for (let i = 0; i < masLargo; i++) for (const b of bloques) { if (i < b.length) flujo.push(b[i]); }
    for (let i = 0; i < nEC; i++) for (const e of ecs) flujo.push(e[i]);
    return { v, flujo };
  }

  /* ── La matriz ────────────────────────────────────────────────────────── */
  function matriz(v, flujo, mascara) {
    const N = 17 + v * 4;
    const M = Array.from({ length: N }, () => new Array(N).fill(null)); // null = libre

    const cuadro = (cy, cx) => {          // buscador 7×7 con su borde blanco
      for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
        const Y = cy + y, X = cx + x;
        if (Y < 0 || Y >= N || X < 0 || X >= N) continue;
        M[Y][X] = (y >= 0 && y <= 6 && x >= 0 && x <= 6 &&
                   (y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4))) ? 1 : 0;
      }
    };
    cuadro(0, 0); cuadro(0, N - 7); cuadro(N - 7, 0);

    for (const cy of ALINEA[v]) for (const cx of ALINEA[v]) {   // alineación 5×5
      if (M[cy][cx] !== null) continue;                          // pisa un buscador: no va
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++)
        M[cy + y][cx + x] = (Math.max(Math.abs(y), Math.abs(x)) !== 1) ? 1 : 0;
    }
    for (let i = 8; i < N - 8; i++) {                            // sincronismo
      if (M[6][i] === null) M[6][i] = (i + 1) % 2;
      if (M[i][6] === null) M[i][6] = (i + 1) % 2;
    }
    M[N - 8][8] = 1;                                             // el módulo oscuro

    // formato: nivel M (00) + máscara, BCH(15,5) con 0x537, XOR 0x5412
    let f = (0b00 << 3) | mascara;
    let r = f << 10;
    for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
    f = ((f << 10) | r) ^ 0x5412;
    const bitF = (i) => (f >> (14 - i)) & 1;
    for (let i = 0; i < 6; i++) M[8][i] = bitF(i);
    M[8][7] = bitF(6); M[8][8] = bitF(7); M[7][8] = bitF(8);
    for (let i = 9; i < 15; i++) M[14 - i][8] = bitF(i);
    for (let i = 0; i < 7; i++) M[N - 1 - i][8] = bitF(i);
    for (let i = 7; i < 15; i++) M[8][N - 15 + i] = bitF(i);

    // Información de versión (v7+): 6 bits de versión + 12 de BCH con el
    // generador 0x1F25, en dos bloques de 3×6 — arriba a la derecha y abajo
    // a la izquierda. Va ANTES del zigzag: escribirla reserva sus celdas.
    if (v >= 7) {
      let vi = v << 12;
      for (let i = 17; i >= 12; i--) if ((vi >> i) & 1) vi ^= 0x1f25 << (i - 12);
      vi |= v << 12;
      for (let i = 0; i < 18; i++) {
        const bit = (vi >> i) & 1;
        M[Math.floor(i / 3)][N - 11 + (i % 3)] = bit;
        M[N - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }

    // los datos, en el zigzag de dos columnas que esquiva la columna 6
    const enmascarar = (y, x, b) => {
      let m;
      switch (mascara) {
        case 0: m = (y + x) % 2 === 0; break;
        case 1: m = y % 2 === 0; break;
        case 2: m = x % 3 === 0; break;
        case 3: m = (y + x) % 3 === 0; break;
        case 4: m = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: m = ((y * x) % 2 + (y * x) % 3) === 0; break;
        case 6: m = ((y * x) % 2 + (y * x) % 3) % 2 === 0; break;
        default: m = ((y + x) % 2 + (y * x) % 3) % 2 === 0;
      }
      return m ? b ^ 1 : b;
    };
    let idx = 0, arriba = true;
    for (let col = N - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < N; k++) {
        const y = arriba ? N - 1 - k : k;
        for (const x of [col, col - 1]) {
          if (M[y][x] !== null) continue;
          const bit = idx < flujo.length * 8 ? (flujo[idx >> 3] >> (7 - (idx & 7))) & 1 : 0;
          M[y][x] = enmascarar(y, x, bit);
          idx++;
        }
      }
      arriba = !arriba;
    }
    return M;
  }

  // Penalización de corridas (regla 1 del estándar): 5 iguales seguidos = 3,
  // +1 por cada uno más. Alcanza para elegir una máscara decente.
  function penal(M) {
    const N = M.length;
    let p = 0;
    const linea = (leer) => {
      let corr = 1, prev = leer(0);
      for (let i = 1; i < N; i++) {
        const c = leer(i);
        if (c === prev) { corr++; if (corr === 5) p += 3; else if (corr > 5) p++; }
        else { corr = 1; prev = c; }
      }
    };
    for (let y = 0; y < N; y++) linea((i) => M[y][i]);
    for (let x = 0; x < N; x++) linea((i) => M[i][x]);
    return p;
  }

  function armar(texto, mascara) {
    const cod = codificar(texto);
    if (!cod) return null;
    if (mascara != null) return matriz(cod.v, cod.flujo, mascara);
    let mejor = null, mejorP = Infinity;
    for (let m = 0; m < 8; m++) {
      const M = matriz(cod.v, cod.flujo, m);
      const p = penal(M);
      if (p < mejorP) { mejorP = p; mejor = M; }
    }
    return mejor;
  }

  window.QR = {
    // La matriz cruda (0/1), para verificación contra otra implementación.
    // `mascara` fuerza una de las ocho; sin ella, elige la de menor penalización.
    matriz: armar,
    // Pinta el código en el canvas con zona de silencio de 4 módulos.
    // Devuelve false si el texto no entra (más de ~331 caracteres).
    pintar(canvas, texto, escala = 6) {
      const M = armar(texto);
      if (!M) return false;
      const N = M.length, Z = 4;
      canvas.width = canvas.height = (N + Z * 2) * escala;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000';
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
        if (M[y][x]) ctx.fillRect((x + Z) * escala, (y + Z) * escala, escala, escala);
      return true;
    },
  };
})();
