/* ==========================================================================
   Editor do diário: botão "Escrever".
   Cria, edita, move e apaga entradas, envia fotos e edita os textos da capa.
   As mudanças aparecem no livro enquanto você escreve; "Salvar" grava
   em data/diario.json (com cópia de segurança automática).
   ========================================================================== */
(() => {
  'use strict';

  const cfgEl = document.getElementById('editor-config');
  const panel = document.getElementById('editor');
  const btnWrite = document.getElementById('btn-write');
  if (!cfgEl || !panel || !btnWrite) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const staticBase = document.body.dataset.static || '/static/';
  const Book = () => window.AgisoBook;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 12).padEnd(10, 'x');
  const EDITOR_WIDTH = 440;

  let isOpen = false;
  let logged = Boolean(cfg.logado) || !cfg.precisa_senha;
  let draft = null;         // o que está sendo editado
  let savedData = null;     // última versão gravada em disco
  let dirty = false;
  let tab = 'entradas';
  let openId = null;
  let confirmDeleteId = null;
  let askClose = false;
  let busy = false;
  let msg = { text: '', ok: false };
  let previewTimer = 0;
  let refs = {};

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c)); });
    return el;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'X-Requested-With': 'agiso', ...(opts.headers || {}) },
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* sem corpo */ }
    if (!res.ok) {
      const err = new Error((data && data.erro) || `Erro ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const needsLogin = () => cfg.precisa_senha && !logged;

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 72)}px`;
  }
  const autosizeAll = () => panel.querySelectorAll('textarea[data-auto]').forEach(autosize);

  function setMsg(text, ok = false) {
    msg = { text, ok };
    if (refs.msg) { refs.msg.textContent = text; refs.msg.className = `ed-msg${ok ? ' ok' : ''}`; }
  }

  function updateStatus() {
    if (refs.status) {
      refs.status.textContent = dirty ? 'Alterações não salvas' : 'Tudo salvo';
      refs.status.className = `ed-status${dirty ? ' dirty' : ''}`;
    }
    if (refs.save) refs.save.disabled = !dirty || busy;
    if (refs.discard) refs.discard.hidden = !dirty;
  }

  /* ------------------------------------------------------------------ */
  /* Pré-visualização no livro                                           */
  /* ------------------------------------------------------------------ */

  function flushPreview() {
    if (!previewTimer) return;
    clearTimeout(previewTimer);
    previewTimer = 0;
    Book().rebuild(draft, {});
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewTimer = 0; Book().rebuild(draft, {}); }, 600);
  }
  function touch() {
    dirty = true;
    askClose = false;
    setMsg('');
    updateStatus();
    schedulePreview();
  }

  /* ------------------------------------------------------------------ */
  /* Campos                                                              */
  /* ------------------------------------------------------------------ */

  function textField(label, value, onInput, opts = {}) {
    const input = h('input', {
      type: 'text', value: value || '', maxlength: opts.max || 200, placeholder: opts.placeholder || '',
      'data-focus': opts.focus ? '' : null,
      oninput: (e) => { onInput(e.target.value); touch(); },
    });
    return h('label', { class: 'ed-field' }, h('span', { text: label }), input);
  }

  function areaField(label, value, onInput, opts = {}) {
    const ta = h('textarea', {
      value: value || '', maxlength: opts.max || 8000, rows: opts.rows || 3, placeholder: opts.placeholder || '',
      'data-auto': '', 'data-focus': opts.focus ? '' : null,
      oninput: (e) => { onInput(e.target.value); autosize(e.target); touch(); },
    });
    return h('label', { class: 'ed-field' }, label ? h('span', { text: label }) : null, ta);
  }

  /* ------------------------------------------------------------------ */
  /* Entradas                                                            */
  /* ------------------------------------------------------------------ */

  function moveItem(arr, from, to) {
    if (to < 0 || to >= arr.length) return;
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
  }

  function addEntry() {
    const last = draft.entradas[draft.entradas.length - 1];
    const m = last && /(\d+)/.exec(last.data || '');
    const data = m ? last.data.replace(/\d+/, String(Number(m[1]) + 1)) : '';
    const entry = { id: uid(), data, titulo: 'Nova entrada', local: '', paragrafos: [''], nota: '' };
    draft.entradas.push(entry);
    openId = entry.id;
    touch();
    render();
    flushPreview();
    Book().goToEntry(draft.entradas.length - 1);
    const t = panel.querySelector('.ed-entry.open input[type="text"]');
    if (t) { t.focus(); t.select(); }
    panel.querySelector('.ed-entry.open')?.scrollIntoView({ block: 'nearest' });
  }

  async function uploadPhoto(entry, file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setMsg('A foto passou de 8 MB.'); return; }
    busy = true;
    setMsg('Enviando a foto…', true);
    try {
      const fd = new FormData();
      fd.append('foto', file);
      const r = await api('/api/foto', { method: 'POST', body: fd });
      entry.paragrafos.push({ imagem: r.caminho, legenda: '' });
      busy = false;
      touch();
      render();
      setMsg('Foto adicionada. Escreva a legenda abaixo dela.', true);
    } catch (err) {
      busy = false;
      if (err.status === 401) { logged = false; render(); }
      setMsg(err.message);
    }
  }

  function blockCard(entry, bi) {
    const b = entry.paragrafos[bi];
    const isPhoto = typeof b === 'object';
    const total = entry.paragrafos.length;
    const tools = h('div', { class: 'ed-block-head' },
      h('span', { class: 'ed-label', text: isPhoto ? 'Foto' : 'Parágrafo' }),
      h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Mover para cima', disabled: bi === 0, text: '↑',
        onclick: () => { moveItem(entry.paragrafos, bi, bi - 1); touch(); render(); } }),
      h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Mover para baixo', disabled: bi === total - 1, text: '↓',
        onclick: () => { moveItem(entry.paragrafos, bi, bi + 1); touch(); render(); } }),
      h('button', { type: 'button', class: 'ed-icon', 'aria-label': isPhoto ? 'Remover a foto' : 'Remover o parágrafo', text: '✕',
        onclick: () => { entry.paragrafos.splice(bi, 1); touch(); render(); } }),
    );
    if (isPhoto) {
      return h('div', { class: 'ed-block' }, tools,
        h('img', { class: 'ed-photo', src: staticBase + b.imagem, alt: '' }),
        textField('Legenda (a lápis, embaixo da foto)', b.legenda, (v) => { b.legenda = v; }, { max: 160 }));
    }
    return h('div', { class: 'ed-block' }, tools, areaField('', b, (v) => { entry.paragrafos[bi] = v; }, { rows: 4 }));
  }

  function entryForm(entry) {
    const fileInput = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true,
      onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; uploadPhoto(entry, f); },
    });
    return h('div', { class: 'ed-form' },
      h('div', { class: 'ed-two' },
        textField('Dia', entry.data, (v) => { entry.data = v; }, { max: 40, placeholder: 'Dia 12' }),
        textField('Local ou coordenadas', entry.local, (v) => { entry.local = v; }, { max: 80, placeholder: 'X: 120   Y: 64   Z: -300' })),
      textField('Título', entry.titulo, (v) => { entry.titulo = v; }, { max: 200, focus: true }),
      h('div', { class: 'ed-label', text: 'Texto' }),
      entry.paragrafos.map((_, bi) => blockCard(entry, bi)),
      h('div', { class: 'ed-add' },
        h('button', { type: 'button', class: 'ed-btn small', text: 'Adicionar parágrafo',
          onclick: () => { entry.paragrafos.push(''); touch(); render(); const t = [...panel.querySelectorAll('.ed-entry.open textarea')].at(-1); if (t) t.focus(); } }),
        h('button', { type: 'button', class: 'ed-btn small', text: 'Adicionar foto', onclick: () => fileInput.click() }),
        fileInput),
      h('p', { class: 'ed-hint', text: 'Use *assim* para sublinhar em vermelho e ~~assim~~ para riscar, como palavra cortada. Cada caixa vira um parágrafo, e o livro cria as páginas sozinho.' }),
      areaField('Nota a lápis no fim da entrada (opcional)', entry.nota, (v) => { entry.nota = v; }, { max: 800, rows: 2 }),
      h('label', { class: 'ed-check' },
        h('input', { type: 'checkbox', checked: Boolean(entry.nova_pagina),
          onchange: (e) => { entry.nova_pagina = e.target.checked; touch(); } }),
        'Começar numa página nova'),
      h('hr', { class: 'ed-sep' }),
      h('div', { class: 'ed-add' },
        h('button', { type: 'button', class: 'ed-btn small', text: 'Ver no livro',
          onclick: () => { flushPreview(); Book().goToEntry(draft.entradas.indexOf(entry)); } }),
        h('button', { type: 'button', class: 'ed-btn small danger',
          text: confirmDeleteId === entry.id ? 'Apagar mesmo?' : 'Apagar entrada',
          onclick: () => {
            if (confirmDeleteId !== entry.id) {
              confirmDeleteId = entry.id;
              render();
              setTimeout(() => { if (confirmDeleteId === entry.id) { confirmDeleteId = null; if (isOpen) render(); } }, 4000);
              return;
            }
            draft.entradas = draft.entradas.filter((e) => e !== entry);
            confirmDeleteId = null;
            openId = null;
            touch();
            render();
          } })),
    );
  }

  function entryCard(entry, k) {
    const open = entry.id === openId;
    const n = draft.entradas.length;
    const label = entry.titulo || 'Sem título';
    return h('div', { class: `ed-entry${open ? ' open' : ''}` },
      h('div', { class: 'ed-row' },
        h('button', { type: 'button', class: 'ed-row-title', 'aria-expanded': String(open),
          onclick: () => {
            openId = open ? null : entry.id;
            confirmDeleteId = null;
            render();
            if (!open) { flushPreview(); Book().goToEntry(draft.entradas.indexOf(entry)); }
          } },
          entry.data ? h('em', { text: entry.data }) : null, label),
        h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Mover entrada para cima', disabled: k === 0, text: '↑',
          onclick: () => { moveItem(draft.entradas, k, k - 1); touch(); render(); } }),
        h('button', { type: 'button', class: 'ed-icon', 'aria-label': 'Mover entrada para baixo', disabled: k === n - 1, text: '↓',
          onclick: () => { moveItem(draft.entradas, k, k + 1); touch(); render(); } })),
      open ? entryForm(entry) : null);
  }

  /* ------------------------------------------------------------------ */
  /* Abas                                                                */
  /* ------------------------------------------------------------------ */

  function entriesTab() {
    return h('div', {},
      h('div', { class: 'ed-add', style: 'margin-bottom:12px' },
        h('button', { type: 'button', class: 'ed-btn primary small', text: 'Nova entrada', onclick: addEntry })),
      draft.entradas.length ? draft.entradas.map(entryCard) : h('p', { class: 'ed-empty', text: 'O diário ainda não tem entradas. Crie a primeira.' }));
  }

  function coverTab() {
    return h('div', { class: 'ed-form', style: 'padding:0' },
      textField('Título do diário', draft.titulo, (v) => { draft.titulo = v; }, { max: 120 }),
      textField('Nome do dono (aparece na plaqueta)', draft.dono, (v) => { draft.dono = v; }, { max: 60 }),
      areaField('Subtítulo da folha de rosto', draft.subtitulo, (v) => { draft.subtitulo = v; }, { max: 300, rows: 2 }),
      areaField('Texto da etiqueta, dentro da capa', draft.ex_libris, (v) => { draft.ex_libris = v; }, { max: 600, rows: 3 }),
      areaField('Texto da última página', draft.fim, (v) => { draft.fim = v; }, { max: 300, rows: 2 }),
      cfg.precisa_senha ? h('div', { class: 'ed-add' },
        h('button', { type: 'button', class: 'ed-btn small', text: 'Sair do modo escrita', onclick: logout })) : null);
  }

  /* ------------------------------------------------------------------ */
  /* Entrar, salvar, fechar                                              */
  /* ------------------------------------------------------------------ */

  async function login(password) {
    busy = true;
    setMsg('Entrando…', true);
    try {
      await api('/api/entrar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: password }) });
      logged = true;
      busy = false;
      start();
    } catch (err) {
      busy = false;
      setMsg(err.message);
    }
  }

  async function logout() {
    try { await api('/api/sair', { method: 'POST' }); } catch (_) { /* ok */ }
    logged = false;
    dirty = false;
    discard(true);
  }

  async function save() {
    if (busy || !dirty) return false;
    flushPreview();
    busy = true;
    updateStatus();
    setMsg('Salvando…', true);
    try {
      const saved = await api('/api/diario', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      draft = saved;
      savedData = clone(saved);
      dirty = false;
      busy = false;
      askClose = false;
      Book().rebuild(saved, {});
      render();
      setMsg('Salvo em data/diario.json.', true);
      return true;
    } catch (err) {
      busy = false;
      if (err.status === 401) { logged = false; render(); }
      updateStatus();
      setMsg(err.message);
      return false;
    }
  }

  function discard(closeAfter) {
    clearTimeout(previewTimer);
    previewTimer = 0;
    if (savedData) Book().rebuild(clone(savedData), {});
    draft = savedData ? clone(savedData) : null;
    dirty = false;
    askClose = false;
    if (closeAfter) closeNow(); else render();
  }

  function requestClose() {
    if (dirty) { askClose = true; render(); return; }
    closeNow();
  }

  function closeNow() {
    isOpen = false;
    panel.hidden = true;
    btnWrite.setAttribute('aria-expanded', 'false');
    Book().setInset(0);
    btnWrite.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Desenho do painel                                                   */
  /* ------------------------------------------------------------------ */

  function loginView() {
    const input = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Senha' });
    const go = () => login(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    refs.msg = h('p', { class: 'ed-msg' });
    refs.msg.textContent = msg.text;
    return h('div', { class: 'ed-login' },
      h('p', { text: 'Para escrever no diário, entre com a senha de edição.' }),
      input,
      h('div', { class: 'ed-add' }, h('button', { type: 'button', class: 'ed-btn primary', text: 'Entrar', onclick: go })),
      refs.msg);
  }

  function render() {
    const prevBody = panel.querySelector('.ed-body');
    const scrollTop = prevBody ? prevBody.scrollTop : 0;
    refs = {};

    const head = h('div', { class: 'ed-head' },
      h('h2', { text: 'Escrever' }),
      refs.status = h('span', { class: 'ed-status' }),
      h('button', { type: 'button', class: 'ed-btn small', text: 'Fechar', onclick: requestClose }));

    if (needsLogin() || !draft) {
      panel.replaceChildren(head, loginView());
      updateStatus();
      if (refs.status) refs.status.textContent = '';
      const pw = panel.querySelector('input[type="password"]');
      if (pw) pw.focus();
      return;
    }

    const tabs = h('div', { class: 'ed-tabs', role: 'tablist' },
      ['entradas', 'capa'].map((id) => h('button', {
        type: 'button', class: 'ed-tab', role: 'tab', 'aria-selected': String(tab === id),
        text: id === 'entradas' ? 'Entradas' : 'Capa e textos',
        onclick: () => { tab = id; render(); },
      })));

    const body = h('div', { class: 'ed-body' }, tab === 'entradas' ? entriesTab() : coverTab());

    const foot = h('div', { class: 'ed-foot' },
      refs.save = h('button', { type: 'button', class: 'ed-btn primary', text: 'Salvar', onclick: save }),
      refs.discard = h('button', { type: 'button', class: 'ed-btn', text: 'Descartar mudanças', onclick: () => discard(false) }),
      askClose ? h('div', { class: 'ed-add', style: 'flex:1 1 100%' },
        h('p', { class: 'ed-msg', text: 'Há alterações não salvas. O que fazer?' }),
        h('button', { type: 'button', class: 'ed-btn small primary', text: 'Salvar e fechar', onclick: async () => { if (await save()) closeNow(); } }),
        h('button', { type: 'button', class: 'ed-btn small danger', text: 'Descartar e fechar', onclick: () => discard(true) }),
        h('button', { type: 'button', class: 'ed-btn small', text: 'Continuar editando', onclick: () => { askClose = false; render(); } })) : null,
      refs.msg = h('p', { class: `ed-msg${msg.ok ? ' ok' : ''}`, text: msg.text }));

    panel.replaceChildren(head, tabs, body, foot);
    body.scrollTop = scrollTop;
    updateStatus();
    autosizeAll();
  }

  /* ------------------------------------------------------------------ */
  /* Abrir                                                               */
  /* ------------------------------------------------------------------ */

  function start() {
    if (!draft) {
      savedData = clone(Book().getData());
      draft = clone(savedData);
      draft.entradas.forEach((e) => { if (!e.id) e.id = uid(); if (!Array.isArray(e.paragrafos)) e.paragrafos = []; });
      const k = Book().entryAtCurrentPage();
      if (k >= 0) openId = draft.entradas[k].id;
    }
    render();
  }

  function openEditor() {
    isOpen = true;
    panel.hidden = false;
    btnWrite.setAttribute('aria-expanded', 'true');
    Book().setInset(window.innerWidth >= 1000 ? EDITOR_WIDTH : 0);
    if (needsLogin()) { render(); return; }
    start();
  }

  btnWrite.addEventListener('click', () => (isOpen ? requestClose() : openEditor()));

  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (e.key === 'Escape' && !e.defaultPrevented) { requestClose(); }
  });
  window.addEventListener('resize', () => { if (isOpen) Book().setInset(window.innerWidth >= 1000 ? EDITOR_WIDTH : 0); });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
})();
