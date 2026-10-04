// ─────────────────────────────────────────────────────────────────────────────
// chat-ia.js — asistente de IA para las demos de demos.hg-vl.com
// Burbuja flotante: el visitante charla con un vendedor o recepcionista de IA
// que reserva mesas / toma pedidos / vende según la página. La inteligencia
// vive en el worker hg-chat-ia (Cloudflare); acá solo hay UI + contexto.
//
// Uso — antes de cargar el script, en cada demo:
//   <script>window.DEMO_CHAT={demo:'serena',negocio:'SERENA',rubro:'lounge & café',
//     rol:'recepcionista',objetivo:'reservar',whatsapp:'549221...',color:'#c9b273'};</script>
//   <script src="../chat-ia.js" defer></script>
//
// Config: demo (slug), negocio, rubro, rol ('recepcionista'|'vendedor'),
//   objetivo ('reservar'|'pedido'|'entradas'|'producto'), whatsapp (solo
//   dígitos, opcional), color (acento), tema ('oscuro'|'claro'), nombre
//   (del asistente, opcional), datos (extra del negocio, opcional),
//   workerUrl (override para pruebas locales).
//   Para una marca que no es demo: tono (cómo habla), firma (quién firma,
//   default 'human glitche'), etiqueta (texto chico del header, default
//   'demo'), demostracion:false (el prompt deja de decir "sos una demo"),
//   marca (slug en la plataforma si difiere del de la demo: las huellas del
//   embudo van a esa marca), api (base de la API para las huellas),
//   fondo/texto (colores del panel; aceptan var(--x) para seguir el tema).
//
// El contexto del negocio NO se duplica a mano: se captura el texto visible
// de la propia página (la carta/productos ya renderizados) y viaja con cada
// consulta — la demo es la fuente de verdad.
// ─────────────────────────────────────────────────────────────────────────────
(function(){
  const CFG = window.DEMO_CHAT || {};
  if (!CFG.demo) return;

  const WORKER_URL = CFG.workerUrl || 'https://hg-chat-ia.tukyquilme.workers.dev';
  const ACCENT  = CFG.color || '#b8ff00';
  const CLARO   = CFG.tema === 'claro';
  const WA      = String(CFG.whatsapp || '').replace(/\D/g, '');
  const LS_KEY  = 'hgchat_demo_' + CFG.demo;
  // Id estable de ESTE navegador. En localStorage, no en sessionStorage: si
  // vuelve mañana queremos reconocerlo, y sin esto no hay forma de atar una
  // conversación a lo que pasó después.
  const ID_KEY = 'hgchat_visitante';
  function visitante() {
    let v = null;
    try { v = localStorage.getItem(ID_KEY); } catch (e) {}
    if (!v) {
      v = 'web-' + [...crypto.getRandomValues(new Uint8Array(8))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem(ID_KEY, v); } catch (e) {}
    }
    return v;
  }
  // ── huellas del embudo: "alguien hizo X en esta demo", a la plataforma.
  // Anónimas (viaja el mismo id al azar del navegador que usa el asistente),
  // una por tipo y por sesión de pestaña, y nunca bloquean nada: si la API no
  // contesta, la demo sigue igual. `via` dice desde dónde llegó: el portal que
  // la embebe (?firma=), el portal de HG, o directo.
  const API_HUELLA = CFG.api || 'https://api.hg-vl.com';
  const VIA = (() => {
    try {
      const f = new URLSearchParams(location.search).get('firma');
      if (f) return f;
      return /demos\.hg-vl\.com|0800webs\.com/.test(document.referrer || '') ? 'portal' : 'directo';
    } catch (e) { return 'directo'; }
  })();
  function huella(tipo, detalle) {
    try {
      const k = 'hgchat_huella_' + CFG.demo + ':' + tipo;
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, '1');
    } catch (e) {}
    try {
      // `marca` cuando el slug de la demo no es el de la marca en plataforma
      // (demo-dstroytime → dstroy); si no, el mismo slug.
      fetch(API_HUELLA + '/v1/' + encodeURIComponent(CFG.marca || CFG.demo) + '/huella', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo, visitante: visitante(), via: VIA, detalle: detalle || undefined }),
      }).catch(() => {});
    } catch (e) {}
  }
  const OFF     = Math.max(0, parseInt(CFG.offsetY, 10) || 0); // sube la burbuja si la página ya tiene un flotante abajo-derecha
  const MAX_HIST_ENVIO = 12;   // mensajes que viajan al worker
  const MAX_INPUT = 500;

  // ── contexto: el texto visible de la página, capturado antes de ensuciar el DOM
  let PAGE_CTX = '';
  function capturarContexto(){
    try {
      const t = (document.body.innerText || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      PAGE_CTX = t.slice(0, 6000);
    } catch(e){ PAGE_CTX = ''; }
  }

  // ── saludo local por objetivo (sin gastar una llamada)
  const SALUDOS = {
    reservar: '¡Hola! ¿Te reservo una mesa? Contame para cuántos y qué día tenés pensado.',
    pedido:   '¡Hola! ¿Te tomo un pedido? Preguntame lo que quieras de la carta.',
    entradas: '¡Hola! ¿Venís a la próxima fecha? Te cuento y te guío para sacar tu entrada acá mismo.',
    producto: '¡Hola! ¿Buscás algo en particular? Te asesoro con el catálogo.',
    web:      'Hola. Si llegaste hasta acá es porque tu comercio existe y tu web no. Contame qué rubro es y te digo cuál te armo.',
    // artistas: no hay mostrador. Lo que se ofrece es entrar y escuchar.
    comunidad:'¡Hola! ¿Querés enterarte de la próxima fecha antes que nadie? Te sumo — o si preferís, te digo por dónde empezar a escuchar.',
    // agencias de representación (mb17): no hay mostrador ni entradas. Lo que se busca es saber quién escribe y qué busca.
    representacion:'¡Hola! ¿Sos jugador, club o entrenador? Contame qué buscás y te digo cómo trabaja la agencia.',
  };
  // Un objetivo que no existe caía en 'reservar' sin decir nada: así fue como
  // el chat de una artista terminó ofreciendo mesas. Que quede rastro.
  if (CFG.objetivo && !SALUDOS[CFG.objetivo])
    console.warn('[chat-ia] objetivo desconocido:', CFG.objetivo, '— usando reservar');

  const esc = t => String(t).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ── estilos
  const fg     = CFG.texto || (CLARO ? '#1a1a1c' : '#f0ede6');
  const panelBg= CFG.fondo || (CLARO ? 'rgba(255,255,255,0.92)' : 'rgba(10,10,12,0.88)');
  // ?firma=<marca> en la URL de la demo: la misma demo, mostrada desde otro portal
  // (0800webs.com/portal/ embebe el banco de demos.hg-vl.com). Cambia la firma del
  // chat y apaga el sello «propuesta de Human Glitche» de la página. Solo se aceptan
  // marcas conocidas: no es un canal para que cualquiera firme lo que quiera.
  const FIRMAS_PORTAL = { '0800webs': '0800webs' };
  const FIRMA_URL = (() => { try { return FIRMAS_PORTAL[new URLSearchParams(location.search).get('firma')] || null; } catch (e) { return null; } })();
  if (FIRMA_URL) {
    const apagar = () => document.querySelectorAll('.demo-tag').forEach((el) => { el.hidden = true; el.style.display = 'none'; });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apagar); else apagar();
  }
  const FIRMA  = FIRMA_URL || CFG.firma || 'human glitche';
  const ETIQ   = CFG.etiqueta || 'demo';
  const bordeS = CLARO ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)';
  const burbA  = CLARO ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)';
  const style = document.createElement('style');
  style.textContent = `
    #hgia-bubble{position:fixed;bottom:${18+OFF}px;right:18px;z-index:990;width:54px;height:54px;
      border-radius:50%;background:${panelBg};backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border:1.5px solid ${ACCENT};display:flex;align-items:center;justify-content:center;cursor:pointer;
      box-shadow:0 4px 24px rgba(0,0,0,${CLARO?'0.18':'0.5'});transition:transform .15s;}
    #hgia-bubble:hover{transform:scale(1.06);}
    #hgia-bubble svg{width:24px;height:24px;stroke:${ACCENT};fill:none;stroke-width:2;}
    #hgia-bubble .hgia-tag{position:absolute;top:-6px;right:-4px;font:700 8px/1 system-ui,sans-serif;
      letter-spacing:.08em;color:${CLARO?'#fff':'#0a0a0c'};background:${ACCENT};border-radius:8px;padding:3px 5px;}
    #hgia-hint{position:fixed;bottom:${30+OFF}px;right:82px;z-index:990;background:${panelBg};color:${fg};
      border:1px solid ${bordeS};border-radius:10px 10px 2px 10px;padding:.5rem .8rem;
      font:12px/1.4 system-ui,sans-serif;max-width:190px;box-shadow:0 4px 18px rgba(0,0,0,.25);
      backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);cursor:pointer;}
    #hgia-panel{position:fixed;bottom:${84+OFF}px;right:18px;z-index:990;width:340px;max-width:calc(100vw - 24px);
      height:480px;max-height:calc(100dvh - ${104+OFF}px);background:${panelBg};
      backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
      border:1px solid ${bordeS};border-top:2px solid ${ACCENT};border-radius:12px;
      display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,${CLARO?'0.22':'0.55'});
      font-family:system-ui,-apple-system,sans-serif;color:${fg};}
    #hgia-panel.show{display:flex;}
    #hgia-head{display:flex;align-items:center;gap:.6rem;padding:.75rem .9rem;
      border-bottom:1px solid ${bordeS};flex-shrink:0;}
    #hgia-head .hgia-avatar{width:34px;height:34px;border-radius:50%;background:${ACCENT}22;
      border:1px solid ${ACCENT};display:flex;align-items:center;justify-content:center;
      font-size:15px;flex-shrink:0;}
    #hgia-head .hgia-who{min-width:0;flex:1;}
    #hgia-head .hgia-neg{font-size:12.5px;font-weight:700;letter-spacing:.04em;white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis;}
    #hgia-head .hgia-sub{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;opacity:.65;}
    #hgia-close{background:none;border:none;color:${fg};opacity:.55;font-size:18px;cursor:pointer;
      padding:.2rem .4rem;line-height:1;}
    #hgia-close:hover{opacity:1;}
    #hgia-msgs{flex:1;overflow-y:auto;padding:.9rem;display:flex;flex-direction:column;gap:.55rem;
      scrollbar-width:thin;}
    .hgia-m{max-width:85%;padding:.55rem .75rem;border-radius:12px;font-size:13.5px;line-height:1.45;
      white-space:pre-wrap;word-wrap:break-word;}
    .hgia-m.a{align-self:flex-start;background:${burbA};border:1px solid ${bordeS};
      border-bottom-left-radius:3px;}
    .hgia-m.u{align-self:flex-end;background:${ACCENT}${CLARO?'':'2e'};
      ${CLARO?`background:${ACCENT}22;`:''}border:1px solid ${ACCENT}66;border-bottom-right-radius:3px;}
    .hgia-m.err{align-self:flex-start;border:1px solid rgba(255,80,80,.4);background:rgba(255,80,80,.08);}
    .hgia-cta{align-self:flex-start;max-width:85%;display:flex;flex-direction:column;gap:.4rem;
      border:1px dashed ${ACCENT};border-radius:12px;padding:.65rem .75rem;font-size:12.5px;line-height:1.45;}
    .hgia-cta b{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${ACCENT};
      ${CLARO?'filter:brightness(.7);':''}}
    .hgia-cta a,.hgia-cta .hgia-fake{display:inline-block;text-align:center;text-decoration:none;
      font-weight:700;font-size:12.5px;padding:.5rem .8rem;border-radius:8px;cursor:pointer;
      background:${ACCENT};color:${CLARO?'#fff':'#0a0a0c'};border:none;}
    .hgia-cta .hgia-nota{font-size:10.5px;opacity:.6;line-height:1.4;}
    #hgia-typing{align-self:flex-start;display:none;padding:.55rem .8rem;}
    #hgia-typing.show{display:flex;gap:4px;}
    #hgia-typing i{width:6px;height:6px;border-radius:50%;background:${ACCENT};opacity:.4;
      animation:hgia-b 1.2s infinite;}
    #hgia-typing i:nth-child(2){animation-delay:.18s}#hgia-typing i:nth-child(3){animation-delay:.36s}
    @keyframes hgia-b{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
    #hgia-form{display:flex;gap:.5rem;padding:.65rem .75rem;border-top:1px solid ${bordeS};flex-shrink:0;}
    #hgia-in{flex:1;background:${CLARO?'rgba(0,0,0,0.04)':'rgba(255,255,255,0.06)'};color:${fg};
      border:1px solid ${bordeS};border-radius:9px;padding:.55rem .7rem;font-size:13.5px;
      font-family:inherit;outline:none;min-width:0;}
    #hgia-in:focus{border-color:${ACCENT};}
    #hgia-send{background:${ACCENT};color:${CLARO?'#fff':'#0a0a0c'};border:none;border-radius:9px;
      padding:0 .95rem;font-weight:800;font-size:13px;cursor:pointer;flex-shrink:0;}
    #hgia-send:disabled{opacity:.45;cursor:default;}
    #hgia-foot{font-size:9px;letter-spacing:.1em;text-transform:uppercase;opacity:.45;
      text-align:center;padding:0 .5rem .5rem;flex-shrink:0;}
    @media (max-width:480px){
      #hgia-panel{right:12px;bottom:${78+OFF}px;width:calc(100vw - 24px);height:70dvh;}
      #hgia-bubble{bottom:${14+OFF}px;right:14px;}
    }`;
  document.head.appendChild(style);

  // ── DOM
  const rolTxt = CFG.rol === 'vendedor' ? 'Vendedor' : 'Recepción';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="hgia-bubble" role="button" aria-label="Abrir chat con asistente" tabindex="0">
      <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.9 8.9 0 0 1-3.9-.9L3 21l2.1-5.2a8 8 0 0 1-1.1-4.3A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>
      <span class="hgia-tag">IA</span>
    </div>
    <div id="hgia-hint">${esc(SALUDOS[CFG.objetivo] ? '¿Te ayudo? Escribime 👋' : '¿Te ayudo?')}</div>
    <div id="hgia-panel" role="dialog" aria-label="Chat con asistente de ${esc(CFG.negocio || CFG.demo)}">
      <div id="hgia-head">
        <div class="hgia-avatar">${CFG.rol === 'vendedor' ? '🛍️' : CFG.rol === 'comunidad' ? '✦' : '💁'}</div>
        <div class="hgia-who">
          <div class="hgia-neg">${esc(CFG.nombre ? CFG.nombre + ' · ' : '')}${esc(CFG.negocio || CFG.demo)}</div>
          <div class="hgia-sub">${rolTxt} · asistente IA · ${esc(ETIQ)}</div>
        </div>
        <button id="hgia-close" aria-label="Cerrar">×</button>
      </div>
      <div id="hgia-msgs"></div>
      <form id="hgia-form">
        <input id="hgia-in" maxlength="${MAX_INPUT}" placeholder="Escribí tu mensaje…" autocomplete="off">
        <button id="hgia-send" type="submit">➤</button>
      </form>
      <div id="hgia-foot">${esc(ETIQ)} · respuestas generadas con IA · ${esc(FIRMA)}</div>
    </div>`;

  const $ = id => wrap.querySelector('#' + id);

  // historia: [{de:'u'|'a', t, accion?}]
  let hist = [];
  try { hist = JSON.parse(sessionStorage.getItem(LS_KEY) || '[]'); } catch(e){}
  const guardar = () => { try { sessionStorage.setItem(LS_KEY, JSON.stringify(hist.slice(-40))); } catch(e){} };

  let msgsEl, typingEl, inEl, sendEl, panelEl, hintEl;

  function scrollAbajo(){ msgsEl.scrollTop = msgsEl.scrollHeight; }

  function pintarMsg(m){
    const div = document.createElement('div');
    div.className = 'hgia-m ' + (m.err ? 'err' : m.de);
    div.textContent = m.t;
    msgsEl.insertBefore(div, typingEl);
    if (m.accion) pintarCTA(m.accion);
  }

  function pintarCTA(resumen){
    const box = document.createElement('div');
    box.className = 'hgia-cta';
    const texto = resumen + ' — (enviado desde la demo de ' + (CFG.negocio || CFG.demo) + ')';
    if (WA) {
      box.innerHTML = `<b>listo para confirmar</b><div>${esc(resumen)}</div>
        <a href="https://wa.me/${WA}?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Confirmar por WhatsApp</a>
        <div class="hgia-nota">Se abre WhatsApp con el mensaje armado — lo mandás vos.</div>`;
    } else {
      box.innerHTML = `<b>listo para confirmar</b><div>${esc(resumen)}</div>
        <span class="hgia-fake">✓ Enviado (simulado)</span>
        <div class="hgia-nota">En la versión real, esto llega directo al WhatsApp del negocio con todos los datos.</div>`;
      box.querySelector('.hgia-fake').addEventListener('click', function(){
        this.textContent = '✓ ¡Recibido! (demo)';
      });
    }
    msgsEl.insertBefore(box, typingEl);
  }

  function saludar(){
    if (hist.length) return;
    const t = SALUDOS[CFG.objetivo] || SALUDOS.reservar;
    hist.push({ de: 'a', t });
    guardar();
    pintarMsg({ de: 'a', t });
  }

  async function enviar(texto){
    huella('chat');                   // solo la primera de la sesión queda (dedupe adentro)
    hist.push({ de: 'u', t: texto });
    guardar();
    pintarMsg({ de: 'u', t: texto });
    inEl.value = '';
    sendEl.disabled = true;
    typingEl.classList.add('show');
    scrollAbajo();
    try {
      const resp = await fetch((window.DEMO_CHAT && window.DEMO_CHAT.workerUrl) || WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demo: CFG.demo,
          persona: { negocio: CFG.negocio, rubro: CFG.rubro, rol: CFG.rol,
                     objetivo: CFG.objetivo, nombre: CFG.nombre, datos: CFG.datos,
                     tono: CFG.tono, firma: CFG.firma, demostracion: CFG.demostracion !== false },
          contexto: PAGE_CTX,
          contacto: visitante(),
          mensajes: hist.filter(m => !m.err).slice(-MAX_HIST_ENVIO).map(m => ({ de: m.de, t: m.t })),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      // protocolo de cierre: última línea ACCION::<resumen> → botón de WhatsApp
      let t = String(data.t).trim(), accion = null;
      const m = t.match(/^ACCION::(.+)$/m);
      if (m) { accion = m[1].trim(); t = t.replace(/^ACCION::.+$/m, '').trim(); }
      const msg = { de: 'a', t: t || '¡Listo!', accion };
      hist.push(msg); guardar(); pintarMsg(msg);
    } catch(e) {
      const t = WA
        ? 'Uy, me quedé sin señal un momento 😅 Probá de nuevo en un ratito, o escribinos directo al WhatsApp.'
        : 'Uy, me quedé sin señal un momento 😅 Probá de nuevo en un ratito.';
      pintarMsg({ de: 'a', t, err: true });
    } finally {
      typingEl.classList.remove('show');
      sendEl.disabled = false;
      scrollAbajo();
      inEl.focus();
    }
  }

  function abrir(){
    panelEl.classList.add('show');
    hintEl.style.display = 'none';
    if (!msgsEl.childElementCount || msgsEl.childElementCount === 1) {
      // repintar historia (typing es el único hijo fijo)
      hist.forEach(m => pintarMsg(m));
      saludar();
    }
    scrollAbajo();
    inEl.focus();
  }
  function cerrar(){ panelEl.classList.remove('show'); }

  function init(){
    capturarContexto();               // ANTES de inyectar el widget: la página pura
    document.body.appendChild(wrap);
    msgsEl = $('hgia-msgs'); inEl = $('hgia-in'); sendEl = $('hgia-send');
    panelEl = $('hgia-panel'); hintEl = $('hgia-hint');
    typingEl = document.createElement('div');
    typingEl.id = 'hgia-typing';
    typingEl.innerHTML = '<i></i><i></i><i></i>';
    msgsEl.appendChild(typingEl);

    $('hgia-bubble').addEventListener('click', () => panelEl.classList.contains('show') ? cerrar() : abrir());
    $('hgia-bubble').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
    hintEl.addEventListener('click', abrir);
    $('hgia-close').addEventListener('click', cerrar);
    $('hgia-form').addEventListener('submit', e => {
      e.preventDefault();
      const t = inEl.value.trim();
      if (t && !sendEl.disabled) enviar(t);
    });
    huella('visita');
    // Cualquier link a WhatsApp de la página o del chat: se captura antes de
    // que navegue, y el fetch va con keepalive para sobrevivir al cambio de pestaña.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || !/wa\.me\/|api\.whatsapp\.com|^whatsapp:/i.test(a.href)) return;
      huella('whatsapp', { desde: a.closest('#hgia-panel') ? 'chat' : 'pagina' });
    }, true);
    // el hint aparece a los 4s y se esconde solo a los 14s (si no abrieron)
    hintEl.style.display = 'none';
    setTimeout(() => { if (!panelEl.classList.contains('show')) hintEl.style.display = 'block'; }, 4000);
    setTimeout(() => { hintEl.style.display = 'none'; }, 14000);
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', () => setTimeout(init, 150)); // deja renderizar los menús JS
})();
