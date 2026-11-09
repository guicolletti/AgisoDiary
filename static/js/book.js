/* ==========================================================================
   Diário de Bordo do Agisö: monta o livro, distribui o texto em páginas
   e anima a virada das folhas com uma página que dobra de verdade.

   Resumo:
   1. lê o diário (JSON colocado na página pelo Flask);
   2. despeja o texto em páginas do tamanho exato do livro (paginação automática);
   3. monta "folhas" com frente e verso: frente = página da direita,
      verso = página da esquerda da folha seguinte;
   4. ao virar, a folha é substituída por uma cópia fatiada em tiras. Cada
      tira gira um pouco mais que a anterior, e a página curva como papel;
   5. o mesmo mecanismo serve para arrastar a página com o mouse.

   Para o editor (editor.js) existe a API pública window.AgisoBook.
   ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const RAD = Math.PI / 180;

  let diario = JSON.parse($('#diario-data').textContent);
  const table = $('#table');
  const stage = $('#stage');
  const book = $('#book');
  const statusEl = $('#status');
  const btnPrev = $('#btn-prev');
  const btnNext = $('#btn-next');
  const btnIndex = $('#btn-index');
  const btnSound = $('#btn-sound');
  const panel = $('#index-panel');
  const staticBase = document.body.dataset.static || '/static/';

  const rootStyle = getComputedStyle(document.documentElement);
  const cssNum = (name) => parseFloat(rootStyle.getPropertyValue(name));
  const PW = cssNum('--pw');
  const PH = cssNum('--ph');
  const BD = cssNum('--bd');
  const LH = cssNum('--lh');
  const FLIP = Math.max(1, parseFloat(rootStyle.getPropertyValue('--flip')) || 1200);
  const TOOLBAR_SPACE = 88;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  // gerador pseudo-aleatório com semente: cada página tem sempre o mesmo "desgaste"
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function waitForFonts() {
    if (!document.fonts || !document.fonts.load) return;
    const wanted = [
      '300 19px "Kalam"',
      '400 27px "IM Fell English"',
      'italic 18px "IM Fell English"',
      '400 24px "Reenie Beanie"',
      '40px "IM Fell English SC"',
    ];
    const loading = Promise.all(wanted.map((f) => document.fonts.load(f).catch(() => null)))
      .then(() => document.fonts.ready);
    // se as fontes não chegarem (sem internet), o livro abre com as de reserva
    await Promise.race([loading, new Promise((res) => setTimeout(res, 2500))]);
  }

  /* ------------------------------------------------------------------ */
  /* Texto: marcação simples (*sublinhado*, ~~riscado~~) em "palavras"    */
  /* ------------------------------------------------------------------ */

  function parseInline(text) {
    const tokens = [];
    let pendingSpace = false;
    const parts = String(text).split(/(\*[^*]+\*|~~[^~]+~~)/).filter((p) => p !== '');
    for (const part of parts) {
      let cls = '';
      let body = part;
      if (part.length > 4 && part.startsWith('~~') && part.endsWith('~~')) { cls = 'strike'; body = part.slice(2, -2); }
      else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) { cls = 'em'; body = part.slice(1, -1); }
      if (/^\s/.test(body)) pendingSpace = true;
      const re = /\S+/g;
      let m;
      let first = true;
      while ((m = re.exec(body))) {
        tokens.push({ w: m[0], c: cls, sp: tokens.length > 0 && (first ? pendingSpace : true) });
        first = false;
        pendingSpace = false;
      }
      pendingSpace = /\s$/.test(body);
    }
    return tokens;
  }

  function renderTokens(tokens, from, to) {
    let html = '';
    let open = '';
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      const space = i > from && t.sp;
      if (open && open !== t.c) { html += '</span>'; open = ''; }
      if (space) html += ' ';
      if (t.c && open !== t.c) { html += `<span class="${t.c}">`; open = t.c; }
      html += esc(t.w);
    }
    if (open) html += '</span>';
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* Paginação: despeja as entradas em páginas do tamanho real           */
  /* ------------------------------------------------------------------ */

  function paginate(entradas) {
    const body = document.createElement('div');
    body.className = 'page-body';
    body.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden';
    stage.appendChild(body);

    const pages = [];        // html de cada página de texto
    const entryPage = [];    // índice (em pages) em que cada entrada começa
    const fits = () => body.scrollHeight <= body.clientHeight + 0.5;
    const flush = () => { if (body.childElementCount) { pages.push(body.innerHTML); body.innerHTML = ''; } };
    const mediaUrl = (src) => (/^(https?:)?\/\//.test(src) || src.startsWith('/') ? src : staticBase + src);

    function maxFit(p, tokens, from) {
      p.innerHTML = renderTokens(tokens, from, tokens.length);
      if (fits()) return tokens.length - from;
      let lo = 0;
      let hi = tokens.length - from - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        p.innerHTML = renderTokens(tokens, from, from + mid);
        if (fits()) lo = mid; else hi = mid - 1;
      }
      p.innerHTML = '';
      return lo;
    }

    entradas.forEach((entrada, k) => {
      if (entrada.nova_pagina) flush();

      // cabeçalho (data, local, título)
      let head = null;
      const temMeta = Boolean(entrada.data || entrada.local);
      if (temMeta || entrada.titulo) {
        head = document.createElement('header');
        head.className = 'entry-head';
        const meta = temMeta
          ? `<div class="meta"><span class="date">${esc(entrada.data || '')}</span>${entrada.local ? `<span class="where">${esc(entrada.local)}</span>` : ''}</div>`
          : '';
        head.innerHTML = `${meta}${entrada.titulo ? `<h2>${esc(entrada.titulo)}</h2>` : ''}`;
        body.appendChild(head);
        if (!fits() && body.childElementCount > 1) { body.removeChild(head); flush(); body.appendChild(head); }
      }
      entryPage[k] = pages.length;

      const moveHeadToNewPage = () => {
        body.removeChild(head);
        flush();
        body.appendChild(head);
        entryPage[k] = pages.length;
      };

      const blocks = (entrada.paragrafos || []).slice();
      if (entrada.nota) blocks.push({ nota: entrada.nota });

      for (const block of blocks) {
        // foto colada na página
        if (typeof block === 'object' && block.imagem) {
          const fig = document.createElement('figure');
          fig.className = 'photo';
          fig.innerHTML = `<img src="${esc(mediaUrl(block.imagem))}" alt="${esc(block.legenda || '')}">${block.legenda ? `<figcaption>${esc(block.legenda)}</figcaption>` : ''}`;
          body.appendChild(fig);
          if (!fits()) {
            body.removeChild(fig);
            if (head && body.lastElementChild === head && body.childElementCount > 1) moveHeadToNewPage(); else flush();
            body.appendChild(fig);
          }
          continue;
        }

        // nota a lápis
        if (typeof block === 'object' && block.nota) {
          const note = document.createElement('p');
          note.className = 'note';
          note.textContent = block.nota;
          body.appendChild(note);
          if (!fits()) { body.removeChild(note); flush(); body.appendChild(note); }
          continue;
        }

        // parágrafo (pode atravessar várias páginas)
        const tokens = parseInline(block);
        let i = 0;
        let guard = 0;
        while (i < tokens.length && guard++ < 500) {
          const p = document.createElement('p');
          if (i > 0) p.className = 'cont';
          body.appendChild(p);
          let n = maxFit(p, tokens, i);
          if (n === 0) {
            body.removeChild(p);
            if (head && body.lastElementChild === head && body.childElementCount > 1) { moveHeadToNewPage(); continue; }
            const soCabecalho = body.childElementCount === 0 || (head && body.childElementCount === 1 && body.lastElementChild === head);
            if (soCabecalho) {
              // página vazia e ainda assim não cabe: força uma palavra para não travar
              body.appendChild(p);
              p.innerHTML = renderTokens(tokens, i, i + 1);
              n = 1;
            } else {
              flush();
              continue;
            }
          }
          p.innerHTML = renderTokens(tokens, i, i + n);
          i += n;
          if (i < tokens.length) flush();
        }
      }
    });

    flush();
    stage.removeChild(body);
    return { pages, entryPage };
  }

  // distância da linha de base ao topo da linha: usada para alinhar a pauta do papel ao texto
  function measureRuleShift() {
    const box = document.createElement('div');
    box.className = 'page-body';
    box.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden';
    box.innerHTML = '<p style="text-indent:0"><span id="probe" style="display:inline-block;width:0;height:0"></span>Agisö</p>';
    stage.appendChild(box);
    const baseline = $('#probe', box).offsetTop - box.firstElementChild.offsetTop;
    stage.removeChild(box);
    const shift = (((baseline + 6 - (LH - 1)) % LH) + LH) % LH;
    document.documentElement.style.setProperty('--rule-shift', `${shift.toFixed(1)}px`);
  }

  /* ------------------------------------------------------------------ */
  /* Montagem das folhas                                                 */
  /* ------------------------------------------------------------------ */

  // preenche textos da capa, folha de rosto etc. a partir do diário
  function bindTexts(root) {
    const dono = (diario.dono || '').trim();
    const values = {
      titulo: diario.titulo,
      dono,
      subtitulo: diario.subtitulo,
      ex_libris: diario.ex_libris,
      fim: diario.fim,
      de_dono: dono ? `de ${dono}` : '',
      inicial: dono ? dono.charAt(0).toUpperCase() : '·',
    };
    root.querySelectorAll('[data-bind]').forEach((n) => {
      const v = values[n.dataset.bind];
      if (v !== undefined) n.textContent = v;
    });
    return root;
  }
  const cloneTpl = (id) => bindTexts(document.getElementById(id).content.firstElementChild.cloneNode(true));

  // borda levemente irregular, como papel cortado à mão (o lado da lombada fica reto)
  function roughClip(side, seed) {
    const r = rng(seed * 7919 + 13);
    let drift = 0;
    const wobble = () => {
      drift = drift * 0.72 + (r() - 0.5) * 3.9;
      return clamp(Math.abs(drift) + (r() < 0.04 ? r() * 3.5 : 0), 0, 5.5);
    };
    const stepX = 26;
    const stepY = 30;
    const xs = [];
    for (let x = 0; x <= PW; x += stepX) xs.push(x);
    const ys = [];
    for (let y = 0; y <= PH; y += stepY) ys.push(y);

    const pts = [];
    if (side === 'front') {            // lombada à esquerda
      pts.push([0, 0]);
      xs.forEach((x) => pts.push([x, wobble()]));
      ys.forEach((y) => pts.push([PW - wobble(), y]));
      xs.slice().reverse().forEach((x) => pts.push([x, PH - wobble()]));
      pts.push([0, PH]);
    } else {                           // lombada à direita
      pts.push([PW, 0]);
      xs.slice().reverse().forEach((x) => pts.push([x, wobble()]));
      ys.forEach((y) => pts.push([wobble(), y]));
      xs.forEach((x) => pts.push([x, PH - wobble()]));
      pts.push([PW, PH]);
    }
    return `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`;
  }

  function pageFace(side, html, index, kind) {
    const face = document.createElement('div');
    face.className = `face page-face ${side}`;
    const r = rng(index * 104729 + 7);
    face.style.setProperty('--bgx', `${Math.floor(r() * 450)}px`);
    face.style.setProperty('--bgy', `${Math.floor(r() * 450)}px`);
    if (r() < 0.4) {                       // mancha de umidade / marca de caneca em algumas páginas
      face.style.setProperty('--sx', `${Math.floor(20 + r() * 60)}%`);
      face.style.setProperty('--sy', `${Math.floor(15 + r() * 70)}%`);
      face.style.setProperty('--sr', `${Math.floor(46 + r() * 70)}px`);
      face.style.setProperty('--sa', (0.1 + r() * 0.16).toFixed(2));
    }
    face.style.clipPath = roughClip(side, index + 1);
    const inner = kind === 'title' ? '' : `<div class="rules"></div><div class="page-body">${html}</div>`;
    face.innerHTML = `${inner}<span class="folio">${kind === 'title' ? '' : index + 1}</span><div class="shade"></div>`;
    if (kind === 'title') face.insertBefore(cloneTpl('tpl-title'), face.firstChild);
    return face;
  }

  let leaves = [];
  let L = 0;                // total de folhas (capa + folhas de papel)
  let totalPages = 0;
  let entryPageIdx = [];
  let faces = [];           // [{el, leaf, side}]

  function clearBook() {
    cancelAllFlips();
    book.querySelectorAll('.leaf, .end-page, .flipper, .cast').forEach((n) => n.remove());
    leaves = [];
    faces = [];
  }

  function buildBook(pages, entryPage) {
    const all = [{ kind: 'title', html: '' }, ...pages.map((html) => ({ kind: 'text', html }))];
    if (all.length % 2 === 1) all.push({ kind: 'blank', html: '' });
    totalPages = all.length;
    entryPageIdx = entryPage.map((p) => p + 1);   // +1 por causa da folha de rosto
    L = totalPages / 2 + 1;

    for (let i = 0; i < L; i++) {
      const leaf = document.createElement('div');
      leaf.className = 'leaf' + (i === 0 ? ' leaf-cover' : '');
      let front;
      let back;
      if (i === 0) {
        front = document.createElement('div');
        front.className = 'face front cover-face';
        front.appendChild(cloneTpl('tpl-cover'));
        front.insertAdjacentHTML('beforeend', '<div class="shade"></div>');
        back = document.createElement('div');
        back.className = 'face back inner-face';
        back.appendChild(cloneTpl('tpl-inner'));
        back.insertAdjacentHTML('beforeend', '<div class="shade"></div>');
      } else {
        const a = all[2 * i - 2];
        const b = all[2 * i - 1];
        front = pageFace('front', a.html, 2 * i - 2, a.kind);
        back = pageFace('back', b.html, 2 * i - 1, b.kind);
      }
      leaf.append(front, back);
      book.appendChild(leaf);
      leaves.push(leaf);
      faces.push({ el: front, leaf: i, side: 'front' }, { el: back, leaf: i, side: 'back' });
    }
    book.appendChild(cloneTpl('tpl-end'));
  }

  /* ------------------------------------------------------------------ */
  /* Estado: c = quantas folhas já foram viradas (0 = livro fechado)     */
  /* ------------------------------------------------------------------ */

  let c = 0;
  let side = 'right';       // só importa no modo "uma página" (celular)
  let mode = 'spread';      // 'spread' = duas páginas, 'single' = uma página
  let scale = 1;
  let inset = 0;            // espaço ocupado pelo editor, à direita

  const zFinal = (i) => {
    const flipped = i < c;
    if (i === 0) return flipped ? 1 : 3 + L;
    return flipped ? 3 + i : 3 + (L - i);
  };

  // número impresso das páginas visíveis
  const leftPrinted = () => (c >= 2 ? 2 * c - 2 : null);
  const rightPrinted = () => (c >= 1 && c < L ? 2 * c - 1 : null);

  function statusText() {
    if (c === 0) return 'Capa';
    const l = leftPrinted();
    const r = rightPrinted();
    if (mode === 'single') {
      if (side === 'left') return l ? `Página ${l} de ${totalPages}` : 'Dentro da capa';
      return r ? `Página ${r} de ${totalPages}` : 'Fim do diário';
    }
    if (l && r) return `Páginas ${l} e ${r} de ${totalPages}`;
    if (r) return `Página ${r} de ${totalPages}`;
    return `Página ${l} de ${totalPages}`;
  }

  function currentPrinted() {
    if (c === 0) return null;
    if (mode === 'single') return side === 'left' ? leftPrinted() || 1 : rightPrinted() || totalPages;
    return rightPrinted() || leftPrinted();
  }

  function shiftFor() {
    const half = (PW + BD) / 2;
    if (mode === 'spread') return c === 0 ? -half : 0;
    return side === 'left' && c > 0 ? half : -half;
  }

  function render() {
    book.style.setProperty('--shift', `${shiftFor()}px`);

    const unflipped = Math.max(0, L - Math.max(c, 1));
    const flipped = Math.max(0, c - 1);
    book.style.setProperty('--tr', `${unflipped ? clamp(unflipped * 1.6 + 2, 2, 13) : 0}px`);
    book.style.setProperty('--tl', `${flipped ? clamp(flipped * 1.6 + 2, 2, 13) : 0}px`);

    statusEl.textContent = statusText();
    btnPrev.disabled = c === 0;
    btnNext.disabled = mode === 'single' ? (c >= L && side === 'right') : c >= L;

    // leitores de tela só enxergam as páginas que estão à vista
    const visible = new Set();
    if (c >= 1) visible.add(`${c - 1}-back`);
    if (c < L) visible.add(`${c}-front`);
    faces.forEach((f) => f.el.setAttribute('aria-hidden', visible.has(`${f.leaf}-${f.side}`) ? 'false' : 'true'));

    const printed = currentPrinted();
    try {
      history.replaceState(null, '', printed ? `#pagina-${printed}` : location.pathname + location.search);
    } catch (_) { /* ok */ }
  }

  /* ------------------------------------------------------------------ */
  /* Física da página                                                    */
  /* ------------------------------------------------------------------ */

  const N_STRIPS = 16;                 // fatias por folha
  const STRIP_W = PW / N_STRIPS;
  const OVERLAP = 1.4;                 // sobreposição para não aparecerem frestas
  const BEND = 44;                     // dobra máxima do canto externo, em graus
  const SHADE_MAX = 0.62;

  const curve = (s) => Math.pow(s, 1.55);              // quanto mais perto da borda, mais a página cede
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const easeFlip = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  // a borda externa vai na frente no começo e fica um pouco para trás ao pousar (resistência do ar)
  const leadShape = (u) => 1 - 1.5 * smooth(0.28, 0.85, u);

  const active = new Map();            // índice da folha -> animação em andamento
  let raf = 0;

  function makeFlipper(i) {
    const leaf = leaves[i];
    const [frontSrc, backSrc] = leaf.children;
    const root = document.createElement('div');
    root.className = 'flipper';
    root.setAttribute('aria-hidden', 'true');

    const strips = [];
    let parent = root;
    for (let j = 0; j < N_STRIPS; j++) {
      const last = j === N_STRIPS - 1;
      const w = STRIP_W + (last ? 0 : OVERLAP);
      const x0 = j * STRIP_W;
      const strip = document.createElement('div');
      strip.className = 'strip';
      strip.style.left = `${j === 0 ? 0 : STRIP_W}px`;
      strip.style.width = `${w}px`;

      const place = (src, left) => {
        const copy = src.cloneNode(true);
        copy.classList.add('in-flipper');
        copy.style.inset = 'auto';
        copy.style.top = '0';
        copy.style.left = `${left}px`;
        return copy;
      };
      const sf = document.createElement('div');
      sf.className = 'sface sf-front';
      sf.appendChild(place(frontSrc, -x0));
      const shF = document.createElement('div');
      shF.className = 'sshade';
      sf.appendChild(shF);

      const sb = document.createElement('div');
      sb.className = 'sface sf-back';
      sb.appendChild(place(backSrc, -(PW - x0 - w)));
      const shB = document.createElement('div');
      shB.className = 'sshade';
      sb.appendChild(shB);

      strip.append(sf, sb);
      parent.appendChild(strip);
      strips.push({ el: strip, shF, shB });
      parent = strip;
    }

    const castR = document.createElement('div');
    castR.className = 'cast cast-r';
    const castL = document.createElement('div');
    castL.className = 'cast cast-l';
    book.append(castR, castL, root);
    return { root, strips, castR, castL };
  }

  // theta: ângulo da lombada (0 = sobre a direita, 180 = sobre a esquerda)
  // lead: quanto a borda externa adianta (+) ou atrasa (−), de -1 a 1
  function poseFlipper(fl, theta, lead, dir) {
    const A = BEND * lead * dir;       // dobra do canto externo, no sentido do movimento
    fl.root.style.transform = `rotateY(${(-theta).toFixed(3)}deg)`;
    let prev = 0;
    for (let j = 0; j < N_STRIPS; j++) {
      const g = curve((j + 1) / N_STRIPS);
      const s = fl.strips[j];
      s.el.style.transform = `rotateY(${(-A * (g - prev)).toFixed(3)}deg)`;
      prev = g;
      const phi = clamp(theta + A * g, 0, 180);
      const shade = (SHADE_MAX * Math.pow(Math.sin(phi * RAD), 1.25)).toFixed(3);
      s.shF.style.opacity = shade;
      s.shB.style.opacity = shade;
    }
    // sombra que a folha projeta na página de baixo
    const mid = (theta + A * 0.55) * RAD;
    const cs = Math.cos(mid);
    const sn = Math.sin(mid);
    fl.castR.style.opacity = cs > 0 ? (0.62 * Math.pow(sn, 0.7)).toFixed(3) : '0';
    fl.castR.style.width = `${PW * Math.max(cs, 0) + 46}px`;
    fl.castL.style.opacity = cs < 0 ? (0.62 * Math.pow(sn, 0.7)).toFixed(3) : '0';
    fl.castL.style.width = `${PW * Math.max(-cs, 0) + 46}px`;
  }

  function startFlipper(i, a) {
    const leaf = leaves[i];
    a.fl = makeFlipper(i);
    a.fl.root.style.zIndex = 1000 + a.dir * i;
    leaf.classList.remove('peek', 'peek-back');
    leaf.style.visibility = 'hidden';      // a folha de verdade espera escondida; a cópia dobrável assume
  }

  function endFlipper(i) {
    const a = active.get(i);
    if (!a) return;
    const leaf = leaves[i];
    if (a.fl) {
      a.fl.root.remove();
      a.fl.castR.remove();
      a.fl.castL.remove();
    }
    leaf.classList.add('snap');
    leaf.classList.toggle('is-flipped', a.finalFlipped);
    void leaf.offsetWidth;
    leaf.classList.remove('snap');
    leaf.style.visibility = '';
    leaf.style.zIndex = zFinal(i);
    active.delete(i);
  }

  function cancelAllFlips() {
    [...active.keys()].forEach((i) => endFlipper(i));
  }

  function tick(now) {
    raf = 0;
    active.forEach((a, i) => {
      if (a.drag || now < a.t0) return;
      if (!a.fl) startFlipper(i, a);
      const u = clamp((now - a.t0) / a.dur, 0, 1);
      const span = Math.abs(a.to - a.from) / 180;
      a.theta = a.from + (a.to - a.from) * easeFlip(u);
      const settle = a.lead0 * (1 - u) * (1 - u);           // continua a dobra de um arraste
      a.lead = clamp(span * Math.sin(Math.PI * u) * leadShape(u) + settle, -1, 1);
      poseFlipper(a.fl, a.theta, a.lead, a.dir);
      if (u >= 1) endFlipper(i);
    });
    if (active.size) loop();
  }
  function loop() { if (!raf) raf = requestAnimationFrame(tick); }

  // vira (ou desvira) a folha i. Se já estiver em movimento, continua de onde está.
  function flipLeaf(i, toFlipped, delay = 0, withSound = true) {
    if (withSound) swish(delay);
    if (i === 0) return flipCover(toFlipped, delay);

    const to = toFlipped ? 180 : 0;
    const now = performance.now();
    const running = active.get(i);
    if (running) {
      if (!running.fl && running.finalFlipped === toFlipped) return;
      const from = running.fl ? running.theta : (toFlipped ? 0 : 180);
      if (!running.fl) { active.delete(i); if (running.finalFlipped !== toFlipped) { /* ainda não começou: nada a fazer */ } return; }
      running.from = from;
      running.to = to;
      running.dir = Math.sign(to - from) || 1;
      running.t0 = now + delay;
      running.dur = Math.max(380, FLIP * Math.pow(Math.abs(to - from) / 180, 0.8));
      running.finalFlipped = toFlipped;
      running.lead0 = running.lead * 0.6;
      running.drag = false;
      loop();
      return;
    }
    active.set(i, {
      fl: null, from: toFlipped ? 0 : 180, to, dir: toFlipped ? 1 : -1, t0: now + delay, dur: FLIP,
      theta: toFlipped ? 0 : 180, lead: 0, lead0: 0, finalFlipped: toFlipped, drag: false,
    });
    loop();
  }

  // a capa é uma tábua de couro: gira rígida, só com a transição do CSS
  function flipCover(toFlipped, delay) {
    const leaf = leaves[0];
    leaf.classList.remove('peek', 'peek-back');
    leaf.style.setProperty('--delay', `${delay}ms`);
    leaf.style.zIndex = 1000 + (toFlipped ? 1 : -1);
    leaf.classList.add('flipping');
    leaf.classList.toggle('is-flipped', toFlipped);
    setTimeout(() => {
      leaf.classList.remove('flipping');
      leaf.style.zIndex = zFinal(0);
    }, FLIP + delay + 90);
  }

  function snapLeaf(i, flipped) {
    const leaf = leaves[i];
    if (active.has(i)) { active.get(i).finalFlipped = flipped; endFlipper(i); return; }
    leaf.classList.add('snap');
    leaf.classList.toggle('is-flipped', flipped);
    void leaf.offsetWidth;
    leaf.classList.remove('snap');
    leaf.style.zIndex = zFinal(i);
  }

  /* ------------------------------------------------------------------ */
  /* Som de papel                                                        */
  /* ------------------------------------------------------------------ */

  let audio = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem('agiso-som') !== 'off'; } catch (_) { /* ok */ }

  function swish(delay = 0) {
    if (!soundOn || reducedMotion.matches) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime + delay / 1000;
      const dur = 0.6;
      const len = Math.floor(audio.sampleRate * dur);
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const env = Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.1)), 1.6) * (1 - x * 0.5);
        data[i] = (Math.random() * 2 - 1) * env;
      }
      const src = audio.createBufferSource();
      src.buffer = buf;
      const filter = audio.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.8;
      filter.frequency.setValueAtTime(650, t0);
      filter.frequency.exponentialRampToValueAtTime(2800, t0 + dur * 0.7);
      const gain = audio.createGain();
      gain.gain.value = 0.2;
      src.connect(filter).connect(gain).connect(audio.destination);
      src.start(t0);
    } catch (_) { /* sem áudio: segue sem som */ }
  }

  /* ------------------------------------------------------------------ */
  /* Navegação                                                           */
  /* ------------------------------------------------------------------ */

  function setPosition(newC, newSide, opts = {}) {
    newC = clamp(newC, 0, L);
    const instant = opts.instant || reducedMotion.matches;
    const steps = Math.abs(newC - c);
    const dir = Math.sign(newC - c);

    if (steps) {
      const list = [];
      if (dir > 0) for (let i = c; i < newC; i++) list.push(i);
      else for (let i = c - 1; i >= newC; i--) list.push(i);
      c = newC;

      // em saltos longos só as últimas folhas animam; as outras mudam de lado de uma vez
      const animCount = instant ? 0 : Math.min(steps, 4);
      const firstAnimated = steps - animCount;
      const stagger = animCount > 1 ? 150 : 0;
      list.forEach((i, k) => {
        if (k < firstAnimated) snapLeaf(i, i < c);
        else flipLeaf(i, i < c, (k - firstAnimated) * stagger, opts.sound !== false && k - firstAnimated < 4);
      });
    }
    if (newSide) side = newSide;
    render();
  }

  function go(dir) {
    clearPeek();
    if (mode === 'single') {
      if (dir > 0) {
        if (side === 'right') { if (c < L) setPosition(c + 1, 'left'); }
        else if (c <= L) setPosition(c, 'right', { sound: false });
      } else if (c > 0) {
        if (side === 'right') setPosition(c, 'left', { sound: false });
        else setPosition(c - 1, 'right');
      }
      return;
    }
    setPosition(c + dir, 'right');
  }

  function jumpToPage(index, opts) {   // index = posição em "all" (0 = folha de rosto)
    const target = index % 2 === 0 ? index / 2 + 1 : (index - 1) / 2 + 2;
    setPosition(Math.min(target, L), index % 2 === 0 ? 'right' : 'left', opts);
  }

  /* ------------------------------------------------------------------ */
  /* Mouse, toque e teclado                                              */
  /* ------------------------------------------------------------------ */

  let peeked = null;
  function clearPeek() {
    if (peeked) peeked.classList.remove('peek', 'peek-back');
    peeked = null;
    table.dataset.hint = '';
  }

  // em qual zona clicável o ponteiro está: 1 = próxima, -1 = anterior, 0 = nenhuma
  function zoneAt(x, y) {
    if (mode === 'single') {
      const w = window.innerWidth - inset;
      if (y > window.innerHeight - 90) return 0;
      if (x > w * 0.68) return 1;
      if (x < w * 0.32) return -1;
      return 0;
    }
    const r = book.getBoundingClientRect();
    const pad = BD * scale;
    const pageW = r.width / 2;
    if (y < r.top - pad || y > r.bottom + pad) return 0;
    if (c === 0) {
      const cover = leaves[0].getBoundingClientRect();
      return x >= cover.left && x <= cover.right ? 1 : 0;
    }
    if (c < L && x >= r.right - pageW * 0.3 && x <= r.right + pad) return 1;
    if (x <= r.left + pageW * 0.3 && x >= r.left - pad) return -1;
    return 0;
  }

  table.addEventListener('pointermove', (e) => {
    if (drag || e.pointerType === 'touch' || mode === 'single') return;
    const z = zoneAt(e.clientX, e.clientY);
    const wantNext = z > 0 && c < L && !active.has(c) ? leaves[c] : null;
    const wantPrev = z < 0 && c > 0 && !active.has(c - 1) ? leaves[c - 1] : null;
    const target = wantNext || wantPrev;
    if (target === peeked) return;
    clearPeek();
    if (wantNext) { wantNext.classList.add('peek'); table.dataset.hint = 'next'; }
    else if (wantPrev) { wantPrev.classList.add('peek-back'); table.dataset.hint = 'prev'; }
    peeked = target;
  });
  table.addEventListener('pointerleave', () => { if (!drag) clearPeek(); });

  /* ----- arrastar a página -------------------------------------------- */

  let suppressClick = false;
  let down = null;      // pressionou, ainda não sabemos se é clique, deslize ou arraste
  let drag = null;      // arraste em andamento

  const spineX = () => { const r = book.getBoundingClientRect(); return r.left + r.width / 2; };
  const thetaFromX = (x) => Math.acos(clamp((x - spineX()) / (PW * scale), -1, 1)) / RAD;

  function beginDrag(e, z) {
    const i = z > 0 ? c : c - 1;
    if (i < 1 || i >= L || active.has(i)) return false;
    const a = {
      fl: null, from: z > 0 ? 0 : 180, to: z > 0 ? 180 : 0, dir: z > 0 ? 1 : -1, t0: 0, dur: 1,
      theta: z > 0 ? 0 : 180, lead: 0, lead0: 0, finalFlipped: z < 0, drag: true, vx: 0, lastX: e.clientX, lastT: performance.now(),
    };
    active.set(i, a);
    startFlipper(i, a);
    clearPeek();
    table.classList.add('is-dragging');
    try { table.setPointerCapture(e.pointerId); } catch (_) { /* ok */ }
    drag = { i, a, z };
    return true;
  }

  function updateDrag(e) {
    const { a } = drag;
    const t = performance.now();
    const dt = Math.max(1, t - a.lastT);
    a.vx = a.vx * 0.6 + ((e.clientX - a.lastX) / dt) * 0.4;
    a.lastX = e.clientX;
    a.lastT = t;
    a.theta = clamp(thetaFromX(e.clientX), 0, 180);
    a.lead = 0.9 * Math.sin(a.theta * RAD);
    poseFlipper(a.fl, a.theta, a.lead, a.dir);
  }

  function endDrag() {
    const { i, a, z } = drag;
    drag = null;
    table.classList.remove('is-dragging');
    const forward = z > 0;
    const progress = forward ? a.theta : 180 - a.theta;          // quanto da viagem já foi feito
    const flick = forward ? -a.vx : a.vx;                         // velocidade no sentido da virada (px/ms)
    const complete = progress > 80 || (flick > 0.45 && progress > 18);
    const toFlipped = complete ? forward : !forward;               // onde a folha termina
    a.from = a.theta;
    a.to = toFlipped ? 180 : 0;
    a.dir = Math.sign(a.to - a.from) || 1;
    a.dur = Math.max(320, FLIP * Math.pow(Math.abs(a.to - a.from) / 180, 0.75));
    a.t0 = performance.now();
    a.lead0 = a.lead;
    a.finalFlipped = toFlipped;
    a.drag = false;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    if (complete) {
      c += forward ? 1 : -1;
      swish(0);
      render();
    }
    loop();
  }

  table.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('.toolbar, .index-panel')) return;
    down = { x: e.clientX, y: e.clientY, z: mode === 'spread' ? zoneAt(e.clientX, e.clientY) : 0, id: e.pointerId };
  });

  table.addEventListener('pointermove', (e) => {
    if (drag) { updateDrag(e); return; }
    if (!down || !down.z) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) < 8) return;
    // só arrasta no sentido certo: para a esquerda a partir da direita, e o contrário
    if ((down.z > 0 && dx < 0) || (down.z < 0 && dx > 0)) {
      if (beginDrag(e, down.z)) updateDrag(e);
      down = null;
    }
  });

  table.addEventListener('pointerup', (e) => {
    if (drag) { endDrag(); down = null; return; }
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    down = null;
    // deslizar o dedo vira a página (modo uma página, ou quando o arraste não pôde começar)
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      go(dx < 0 ? 1 : -1);
    }
  });
  table.addEventListener('pointercancel', () => { if (drag) endDrag(); down = null; });

  table.addEventListener('click', (e) => {
    if (suppressClick || e.target.closest('.toolbar, .index-panel')) return;
    const sel = window.getSelection && window.getSelection().toString();
    if (sel) return;
    if (!panel.hidden) { closePanel(); return; }
    const z = zoneAt(e.clientX, e.clientY);
    if (z) go(z);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape' && !panel.hidden) { closePanel(); btnIndex.focus(); return; }
    if (t && t.closest && t.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setPosition(0, 'right'); }
    else if (e.key === 'End') { e.preventDefault(); setPosition(L, 'left'); }
    else if ((e.key === 'Enter' || e.key === ' ') && c === 0) { e.preventDefault(); go(1); }
  });

  btnPrev.addEventListener('click', () => go(-1));
  btnNext.addEventListener('click', () => go(1));

  function syncSoundButton() {
    btnSound.setAttribute('aria-pressed', String(soundOn));
    btnSound.title = soundOn ? 'Desligar o som de virar página' : 'Ligar o som de virar página';
  }
  btnSound.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('agiso-som', soundOn ? 'on' : 'off'); } catch (_) { /* ok */ }
    syncSoundButton();
    if (soundOn) swish();
  });
  syncSoundButton();

  /* ------------------------------------------------------------------ */
  /* Painel de registros                                                 */
  /* ------------------------------------------------------------------ */

  function buildIndex() {
    const list = $('#index-list');
    list.innerHTML = '';
    (diario.entradas || []).forEach((e, k) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<span class="ip-date">${esc(e.data || '')}</span><span class="ip-title">${esc(e.titulo || 'Sem título')}</span><span class="ip-dots"></span><span class="ip-page">${entryPageIdx[k] + 1}</span>`;
      b.addEventListener('click', () => { closePanel(); jumpToPage(entryPageIdx[k]); });
      li.appendChild(b);
      list.appendChild(li);
    });
    if (!list.children.length) list.innerHTML = '<li class="ip-empty">Ainda não há registros.</li>';
  }
  function openPanel() { panel.hidden = false; btnIndex.setAttribute('aria-expanded', 'true'); const first = panel.querySelector('button'); if (first) first.focus(); }
  function closePanel() { panel.hidden = true; btnIndex.setAttribute('aria-expanded', 'false'); }
  btnIndex.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden ? openPanel() : closePanel(); });

  /* ------------------------------------------------------------------ */
  /* Tamanho da janela                                                   */
  /* ------------------------------------------------------------------ */

  function layout() {
    const vw = window.innerWidth - inset;
    const vh = window.innerHeight;
    const sSpread = Math.min((vw - 32) / (2 * PW + 2 * BD), (vh - TOOLBAR_SPACE - 24) / (PH + 2 * BD), 1.3);
    const sSingle = Math.min((vw - 16) / (PW + 2 * BD), (vh - TOOLBAR_SPACE - 24) / (PH + 2 * BD), 1.5);
    const newMode = sSpread >= 0.6 ? 'spread' : 'single';
    if (newMode !== mode) {
      mode = newMode;
      side = c === 0 || c < L ? 'right' : 'left';
      if (mode === 'single' && c === 1) side = 'right';
    }
    scale = mode === 'spread' ? sSpread : sSingle;
    stage.style.setProperty('--scale', scale.toFixed(4));
    stage.style.setProperty('--cx', `${vw / 2}px`);
    stage.style.setProperty('--cy', `${(vh - TOOLBAR_SPACE) / 2 + 8}px`);
    document.documentElement.style.setProperty('--inset', `${inset}px`);
    book.dataset.mode = mode;
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      book.classList.add('no-anim');
      layout();
      render();
      void book.offsetWidth;
      book.classList.remove('no-anim');
    }, 120);
  });

  window.addEventListener('hashchange', () => {
    const n = pageFromHash();
    if (n && n !== currentPrinted()) jumpToPage(n - 1);
    else if (!location.hash && c !== 0) setPosition(0, 'right');
  });

  function pageFromHash() {
    const m = /^#pagina-(\d+)$/.exec(location.hash);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= totalPages ? n : null;
  }

  /* ------------------------------------------------------------------ */
  /* Montar / remontar o livro                                           */
  /* ------------------------------------------------------------------ */

  // refaz páginas e folhas. Mantém a página aberta, a menos que se peça outra.
  function assemble(data, { entry = null, instant = true } = {}) {
    diario = data;
    document.title = `${diario.titulo || 'Diário'} · ${diario.dono || ''}`;
    const prev = { c, side };
    clearBook();
    const { pages, entryPage } = paginate(diario.entradas || []);
    buildBook(pages, entryPage);
    buildIndex();

    c = clamp(prev.c, 0, L);
    side = prev.side;
    book.classList.add('no-anim');
    leaves.forEach((leaf, i) => {
      leaf.classList.toggle('is-flipped', i < c);
      leaf.style.zIndex = zFinal(i);
    });
    layout();
    render();
    void book.offsetWidth;
    book.classList.remove('no-anim');
    if (entry !== null && entryPageIdx[entry] !== undefined) jumpToPage(entryPageIdx[entry], { instant });
  }

  // índice da entrada que está na página à vista (ou -1)
  function entryAtCurrentPage() {
    const printed = currentPrinted();
    if (!printed) return -1;
    const idx = printed - 1;
    let found = -1;
    entryPageIdx.forEach((p, k) => { if (p <= idx) found = k; });
    return found;
  }

  window.AgisoBook = {
    getData: () => diario,
    rebuild: (data, opts) => assemble(data, opts),
    goToEntry: (k) => { if (entryPageIdx[k] !== undefined) jumpToPage(entryPageIdx[k]); },
    entryAtCurrentPage,
    setInset: (px) => {
      inset = px;
      layout();
      render();
    },
    get ready() { return document.documentElement.classList.contains('is-ready'); },
  };

  /* ------------------------------------------------------------------ */
  /* Início                                                              */
  /* ------------------------------------------------------------------ */

  (async function init() {
    await waitForFonts();
    layout();
    measureRuleShift();
    assemble(diario, {});

    const start = pageFromHash();
    if (start) {
      const idx = start - 1;
      c = Math.min(idx % 2 === 0 ? idx / 2 + 1 : (idx - 1) / 2 + 2, L);
      side = idx % 2 === 0 ? 'right' : 'left';
      book.classList.add('no-anim');
      leaves.forEach((leaf, i) => {
        leaf.classList.toggle('is-flipped', i < c);
        leaf.style.zIndex = zFinal(i);
      });
      render();
      void book.offsetWidth;
      book.classList.remove('no-anim');
    }
    document.body.classList.add('is-ready');
    document.documentElement.classList.add('is-ready');
  })();
})();
