/** The approval page. One self-contained document, no external requests. */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>belayd</title>
<style nonce="${nonce}">
  :root {
    --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #ffffff; --line: #e7e5e4;
    --code: #f5f5f4; --rope: #ea580c; --allow: #15803d; --deny: #b91c1c; --shadow: 0 1px 2px rgb(0 0 0 / .06);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --card: #1c1917; --line: #292524;
      --code: #0c0a09; --allow: #22c55e; --deny: #f87171; --shadow: none; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 28px; }
  .logo { font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
  .logo b { color: var(--rope); }
  .sub { color: var(--muted); }
  .live { margin-left: auto; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--allow); }
  .dot.off { background: var(--deny); }
  .empty { border: 1px dashed var(--line); border-radius: 12px; padding: 36px 24px; text-align: center; color: var(--muted); }
  .empty strong { display: block; color: var(--fg); font-weight: 600; margin-bottom: 4px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px;
    margin-bottom: 14px; box-shadow: var(--shadow); }
  .card.first { border-color: var(--rope); }
  .meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
  .agent { color: var(--fg); font-weight: 600; }
  .left { margin-left: auto; font-variant-numeric: tabular-nums; }
  .left.soon { color: var(--deny); font-weight: 600; }
  pre { margin: 0 0 10px; padding: 12px 14px; background: var(--code); border: 1px solid var(--line); border-radius: 8px;
    font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .why { margin: 0 0 14px; }
  .rule { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 10px; }
  button { font: inherit; font-weight: 600; border-radius: 8px; padding: 8px 18px; cursor: pointer; border: 1px solid var(--line);
    background: transparent; color: var(--fg); }
  button.allow { background: var(--allow); border-color: var(--allow); color: #fff; }
  button.deny { color: var(--deny); border-color: var(--deny); }
  button:disabled { opacity: .5; cursor: default; }
  kbd { font: 12px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; margin-left: 6px; opacity: .8; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 36px 0 10px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  li code { font: 13px ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .tag { font-size: 12px; font-weight: 600; min-width: 64px; }
  .tag.allowed { color: var(--allow); } .tag.denied { color: var(--deny); } .tag.gone { color: var(--muted); }
  footer { margin-top: 40px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="logo">belay<b>d</b></span><span class="sub">approvals</span>
    <span class="live"><span class="dot" id="dot"></span><span id="live">watching</span></span>
  </header>
  <section id="pending"></section>
  <h2>Recent</h2>
  <ul id="recent"></ul>
  <footer>Nothing leaves this machine. No answer before the timer runs out counts as a no.</footer>
</div>
<script nonce="${nonce}">
  const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot CLI', gemini: 'Gemini CLI', mcp: 'MCP server', cli: 'belayd' };
  const $ = (id) => document.getElementById(id);
  let state = { pending: [], recent: [] };
  let fetchedAt = Date.now();

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const project = (p) => p.split('/').filter(Boolean).pop() || p;
  const clock = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  async function decide(id, decision, buttons) {
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fetch('/api/decide', { method: 'POST', headers: { 'content-type': 'application/json', 'x-belayd': '1' },
        body: JSON.stringify({ id, decision }) });
    } finally { load(); }
  }

  function render() {
    const elapsed = Date.now() - fetchedAt;
    const box = $('pending');
    box.replaceChildren();
    if (state.pending.length === 0) {
      box.append(el('div', { class: 'empty' }, el('strong', {}, 'Nothing waiting.'),
        'belayd will ping you when an agent needs a yes or no.'));
    }
    state.pending.forEach((p, i) => {
      const left = Math.max(0, p.remainingMs - elapsed);
      const allow = el('button', { class: 'allow' }, 'Allow');
      const deny = el('button', { class: 'deny' }, 'Deny');
      if (i === 0) { allow.append(el('kbd', {}, 'A')); deny.append(el('kbd', {}, 'D')); }
      allow.addEventListener('click', () => decide(p.id, 'allow', [allow, deny]));
      deny.addEventListener('click', () => decide(p.id, 'deny', [allow, deny]));
      box.append(el('article', { class: 'card' + (i === 0 ? ' first' : '') },
        el('div', { class: 'meta' }, el('span', { class: 'agent' }, AGENTS[p.agent] || p.agent),
          el('span', {}, project(p.workspace)), el('span', { class: 'left' + (left < 20000 ? ' soon' : '') }, clock(left) + ' left')),
        el('pre', {}, p.label),
        el('p', { class: 'why' }, p.reason, p.ruleId ? el('span', { class: 'rule' }, '  ·  ' + p.ruleId) : null),
        el('div', { class: 'actions' }, deny, allow)));
    });
    const list = $('recent');
    list.replaceChildren();
    if (state.recent.length === 0) list.append(el('li', { class: 'tag gone' }, 'Nothing yet.'));
    for (const r of state.recent) {
      const word = r.outcome === 'gone' ? 'elsewhere' : r.outcome;
      list.append(el('li', {}, el('span', { class: 'tag ' + r.outcome }, word), el('code', {}, r.label)));
    }
    document.title = state.pending.length ? '(' + state.pending.length + ') belayd' : 'belayd';
  }

  async function load() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      state = await res.json();
      fetchedAt = Date.now();
      $('dot').className = 'dot'; $('live').textContent = 'watching';
    } catch {
      $('dot').className = 'dot off'; $('live').textContent = 'belayd is not running';
    }
    render();
  }

  document.addEventListener('keydown', (e) => {
    const first = document.querySelector('.card.first');
    if (!first || e.metaKey || e.ctrlKey) return;
    if (e.key === 'a') first.querySelector('button.allow').click();
    if (e.key === 'd') first.querySelector('button.deny').click();
  });
  load();
  setInterval(load, 1000);
  setInterval(render, 250);
</script>
</body>
</html>`;
}
