/**
 * The whole dashboard page: one HTML string with inline CSS and JS, no
 * external assets, so it works offline and inside the container. It only
 * reads the JSON endpoints in server.ts and refreshes itself every 30 s.
 */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Digest agent</title>
<style>
  :root {
    --bg: #eef1f4; --panel: #ffffff; --ink: #1b2126; --muted: #5f6b76; --rule: #d9dfe5;
    --accent: #0f8a7a; --ok: #2e8b57; --warn: #c7791b; --bad: #b3362d; --soft: #e3ece9;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14181c; --panel: #1c2228; --ink: #e6eaee; --muted: #94a0ab; --rule: #2c353d;
      --accent: #3fc0ad; --ok: #5cbf85; --warn: #e0a04a; --bad: #e0685c; --soft: #22302d;
    }
  }
  * { box-sizing: border-box; }
  html { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-variant-numeric: tabular-nums; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 24px 64px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px; margin-bottom: 8px; }
  header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: 0; }
  header .refresh { color: var(--muted); font-size: 12px; margin-left: auto; }
  header .refresh button { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
  header .refresh button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #status { font-size: 24px; line-height: 1.3; font-weight: 500; margin: 12px 0 6px; max-width: 34em; }
  #status .dot { display: inline-block; width: .55em; height: .55em; border-radius: 50%; margin: 0 .3em .05em 0; background: var(--muted); }
  #status .dot.ok { background: var(--ok); } #status .dot.warn { background: var(--warn); } #status .dot.bad { background: var(--bad); }
  #status-sub { color: var(--muted); margin: 0 0 28px; }
  section { margin-top: 32px; }
  section h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  section p.lead { margin: 0 0 12px; color: var(--muted); }
  .table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 12px; vertical-align: top; border-top: 1px solid var(--rule); }
  th { border-top: 0; color: var(--muted); font-weight: 500; font-size: 12px; white-space: nowrap; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  td .muted, .muted { color: var(--muted); }
  td .name { font-weight: 600; }
  td .sub { display: block; color: var(--muted); font-size: 12px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 12px; background: var(--soft); color: var(--ink); white-space: nowrap; }
  .pill.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); }
  .pill.warn { background: color-mix(in srgb, var(--warn) 22%, transparent); }
  .pill.bad { background: color-mix(in srgb, var(--bad) 20%, transparent); }
  .pill.post { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  svg.activity { width: 126px; height: 22px; display: block; }
  svg.activity rect { fill: var(--accent); }
  svg.activity rect.empty { fill: var(--rule); }
  details summary { cursor: pointer; color: var(--accent); }
  details summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  details pre { white-space: pre-wrap; margin: 8px 0 0; font: inherit; max-width: 70ch; }
  .empty { padding: 14px 12px; color: var(--muted); }
  .error-text { color: var(--bad); }
  @media (max-width: 640px) {
    main { padding: 20px 14px 48px; }
    #status { font-size: 20px; }
    th, td { padding: 8px 8px; }
  }
  @media (prefers-reduced-motion: no-preference) {
    #status { transition: opacity .2s; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Digest agent</h1>
    <span id="tenant" class="muted"></span>
    <span class="refresh"><span id="updated">loading…</span> <button type="button" id="reload">refresh</button></span>
  </header>
  <p id="status"><span class="dot"></span>Loading…</p>
  <p id="status-sub"></p>

  <section>
    <h2>Groups</h2>
    <p class="lead">Every allow-listed group, what it is set to do, and how much has arrived since its last digest.</p>
    <div class="table-wrap"><table id="groups"></table></div>
  </section>

  <section>
    <h2>Runs</h2>
    <p class="lead">Every digest attempt, newest first. Dry runs from the shell are included.</p>
    <div class="table-wrap"><table id="runs"></table></div>
  </section>

  <section>
    <h2>Summaries</h2>
    <p class="lead">The text that was written and where it went.</p>
    <div class="table-wrap"><table id="summaries"></table></div>
  </section>

  <section>
    <h2>Questions</h2>
    <p class="lead">Answers given to <code>/ask</code> and <code>digest ask</code>.</p>
    <div class="table-wrap"><table id="questions"></table></div>
  </section>

  <section>
    <h2>Outbox</h2>
    <p class="lead">WhatsApp sends waiting for the listener, then the most recent ones that went out.</p>
    <div class="table-wrap"><table id="outbox"></table></div>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let lastLoad = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTs = (ts) => ts == null ? '—' : new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts * 1000)).replace(',', '');
  const ago = (ts, now) => {
    if (ts == null) return '—';
    const s = Math.max(0, now - ts);
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };
  const usd = (v) => v == null ? '—' : v === 0 ? '$0' : '$' + v.toFixed(v < 0.01 ? 4 : 2);
  const secs = (ms) => ms == null ? '—' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const n = (v) => v == null ? '—' : v.toLocaleString();
  const statusClass = (s) => s === 'ok' || s === 'sent' ? 'ok' : s === 'error' || s === 'failed' ? 'bad' : s === 'queued' || s === 'empty' ? 'warn' : '';
  const pill = (s, cls) => '<span class="pill ' + (cls ?? statusClass(s)) + '">' + esc(s) + '</span>';

  const table = (id, head, rows, empty) => {
    const t = $(id);
    if (rows.length === 0) { t.innerHTML = '<tr><td class="empty">' + esc(empty) + '</td></tr>'; return; }
    t.innerHTML = '<thead><tr>' + head.map((h) => '<th' + (h.endsWith('#') ? ' class="num"' : '') + '>' + esc(h.replace(/#$/, '')) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody>';
  };

  const activity = (days) => {
    // Last 14 local days, oldest left. Missing days are drawn as empty.
    const byDay = new Map(days.map((d) => [d.day, d.count]));
    const max = Math.max(1, ...days.map((d) => d.count));
    const out = [];
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let i = 13; i >= 0; i--) {
      const day = fmt.format(new Date(Date.now() - i * 86400000));
      const c = byDay.get(day) ?? 0;
      const h = c === 0 ? 2 : Math.max(3, Math.round((c / max) * 20));
      out.push('<rect x="' + ((13 - i) * 9) + '" y="' + (22 - h) + '" width="7" height="' + h + '" rx="1"' + (c === 0 ? ' class="empty"' : '') + '><title>' + day + ': ' + c + '</title></rect>');
    }
    return '<svg class="activity" viewBox="0 0 126 22" role="img" aria-label="messages per day, last two weeks">' + out.join('') + '</svg>';
  };

  const deliverText = (d) => {
    const parts = [];
    if (d.self_dm) parts.push('self-DM');
    if (d.vault) parts.push('vault');
    if (d.group) parts.push(pill('posts to group', 'post'));
    return parts.length ? parts.join(', ') : '<span class="muted">nothing</span>';
  };

  async function load() {
    const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + ' → ' + r.status); return r.json(); });
    let status;
    try {
      [status] = await Promise.all([get('/api/status')]);
    } catch (e) {
      $('status').innerHTML = '<span class="dot bad"></span>Cannot reach the agent';
      $('status-sub').textContent = String(e);
      $('updated').textContent = 'failed';
      return;
    }
    tz = status.tz || tz;
    const now = status.nowTs;
    const [groups, runs, summaries, questions, outbox] = await Promise.all([
      get('/api/groups'), get('/api/runs?limit=40'), get('/api/summaries?limit=20'), get('/api/questions?limit=20'), get('/api/outbox?limit=20'),
    ]);

    $('tenant').textContent = 'tenant ' + status.tenantId + (status.version ? ' · v' + status.version : '');
    const sessionWords = { connected: 'Connected', connecting: 'Connecting', pairing: 'Waiting for QR pairing', reconnecting: 'Reconnecting', logged_out: 'Logged out by WhatsApp', unknown: 'Session state not available' };
    const sessionCls = { connected: 'ok', connecting: 'warn', pairing: 'warn', reconnecting: 'warn', logged_out: 'bad', unknown: '' };
    const due = groups.filter((g) => g.due && g.due.due).length;
    const bits = [];
    bits.push(status.groupsConfigured + (status.groupsConfigured === 1 ? ' group' : ' groups'));
    bits.push(status.sendsToday + ' of ' + status.maxSendsPerDay + ' sends used today');
    if (status.pendingSends) bits.push(status.pendingSends + ' waiting to send');
    if (status.failedSends) bits.push(status.failedSends + ' failed');
    if (due) bits.push(due + ' due now');
    $('status').innerHTML = '<span class="dot ' + (sessionCls[status.session] ?? '') + '"></span>' + esc(sessionWords[status.session] ?? status.session) + '. ' + esc(bits.join(', ')) + '.';
    const sub = [];
    if (status.uptimeS != null) sub.push('Up ' + ago(now - status.uptimeS, now).replace(' ago', ''));
    sub.push('Default summarizer ' + status.defaultSummarizer);
    sub.push('Messages kept ' + status.retentionDays + ' days');
    sub.push('Times in ' + tz);
    if (status.session === 'unknown') sub.push('This is a standalone viewer; the session state lives in the running listener');
    $('status-sub').textContent = sub.join('. ') + '.';

    table('groups', ['Group', 'Schedule', 'Delivers to', 'Stored#', 'Last message', 'Since last digest', 'Last run', 'Activity (14 d)'], groups.map((g) => {
      const dueText = g.due.due ? pill('due: ' + g.due.reason, 'warn') : '<span class="muted">' + esc(g.due.reason) + '</span>';
      const lr = g.lastRun;
      const lastRun = lr ? fmtTs(lr.createdTs) + ' ' + pill(lr.status) + '<span class="sub">' + esc(lr.trigger) + (lr.costUsd != null ? ' · ' + usd(lr.costUsd) : '') + (lr.error ? ' · ' + esc(lr.error) : '') + '</span>' : '<span class="muted">never</span>';
      const pending = g.cadenceType === 'threshold' ? n(g.pendingMessages) + ' messages' : (g.watermarkTs ? ago(g.watermarkTs, now) : '<span class="muted">no digest yet</span>');
      return '<tr><td><span class="name">' + esc(g.name) + '</span><span class="sub">' + esc(g.summarizer) + ' · ' + esc(g.style) + ' · ' + esc(g.language) + (g.personality !== 'neutral' ? ' · ' + esc(g.personality) : '') + '</span></td>'
        + '<td>' + esc(g.cadence) + '<span class="sub">' + dueText + '</span></td>'
        + '<td>' + deliverText(g.deliver) + '</td>'
        + '<td class="num">' + n(g.messagesStored) + '</td>'
        + '<td>' + (g.lastMessageTs ? esc(ago(g.lastMessageTs, now)) + '<span class="sub">' + fmtTs(g.lastMessageTs) + '</span>' : '<span class="muted">none</span>') + '</td>'
        + '<td>' + pending + '</td>'
        + '<td>' + lastRun + '</td>'
        + '<td>' + activity(g.activity) + '</td></tr>';
    }), 'No groups configured. Add them under groups: in config.yaml.');

    table('runs', ['When', 'Group', 'Trigger', 'Status', 'Messages#', 'Adapter', 'Cost#', 'Took#'], runs.map((r) =>
      '<tr><td>' + fmtTs(r.createdTs) + '</td><td>' + esc(r.groupName) + '</td><td>' + esc(r.trigger) + (r.dryRun ? ' <span class="muted">dry run</span>' : '') + '</td>'
      + '<td>' + pill(r.status) + (r.error ? '<span class="sub error-text">' + esc(r.error) + '</span>' : '') + '</td>'
      + '<td class="num">' + n(r.messageCount) + '</td><td>' + esc(r.adapter) + (r.model ? '<span class="sub">' + esc(r.model) + '</span>' : '') + '</td>'
      + '<td class="num">' + usd(r.costUsd) + '</td><td class="num">' + secs(r.durationMs) + '</td></tr>'
    ), 'No digests have run yet.');

    table('summaries', ['Written', 'Group', 'Window', 'Messages#', 'Delivered', 'Text'], summaries.map((s) => {
      const del = s.deliveries.length ? s.deliveries.map((d) => pill(d.channel + ' ' + d.status, statusClass(d.status)) + (d.error ? '<span class="sub error-text">' + esc(d.error) + '</span>' : '')).join(' ') : '<span class="muted">not delivered</span>';
      return '<tr><td>' + fmtTs(s.createdTs) + '</td><td>' + esc(s.groupName) + '</td><td>' + fmtTs(s.sinceTs) + ' → ' + fmtTs(s.untilTs) + '</td>'
        + '<td class="num">' + n(s.messageCount) + '</td><td>' + del + '</td>'
        + '<td><details><summary>' + esc(s.text.split('\n')[0].slice(0, 80)) + (s.text.length > 80 ? '…' : '') + '</summary><pre>' + esc(s.text) + '</pre></details></td></tr>';
    }), 'No summaries yet. Try: digest summarize <group> --since 2d --dry-run');

    table('questions', ['Asked', 'Group', 'Question', 'Answer', 'Messages#', 'Cost#'], questions.map((q) =>
      '<tr><td>' + fmtTs(q.createdTs) + '</td><td>' + esc(q.groupName) + '</td><td>' + esc(q.question) + '</td>'
      + '<td>' + (q.status === 'ok' ? '<details><summary>' + esc((q.answer || '').split('\n')[0].slice(0, 80)) + '</summary><pre>' + esc(q.answer) + '</pre></details>' : pill('failed', 'bad') + '<span class="sub error-text">' + esc(q.error) + '</span>') + '</td>'
      + '<td class="num">' + n(q.messageCount) + '</td><td class="num">' + usd(q.costUsd) + '</td></tr>'
    ), 'No questions asked yet. Send /ask <group> <question> in your own chat.');

    const outRows = [];
    for (const d of outbox.pending) outRows.push('<tr><td>' + fmtTs(d.createdTs) + '</td><td>' + esc(d.channel) + '</td><td>' + esc(d.target || '—') + '</td><td>' + pill(d.status) + (d.error ? '<span class="sub error-text">' + esc(d.error) + '</span>' : '') + '</td><td class="num">' + n(d.attempts) + '</td></tr>');
    for (const d of outbox.recent) outRows.push('<tr><td>' + fmtTs(d.sentTs) + '</td><td>' + esc(d.channel) + '</td><td>' + esc(d.target || '—') + '</td><td>' + pill(d.status) + '</td><td class="num">' + n(d.attempts) + '</td></tr>');
    table('outbox', ['When', 'Channel', 'Target', 'Status', 'Attempts#'], outRows, 'Nothing has been sent or queued.');

    lastLoad = Date.now();
    tick();
  }

  function tick() {
    if (!lastLoad) return;
    $('updated').textContent = 'updated ' + Math.round((Date.now() - lastLoad) / 1000) + ' s ago';
  }

  $('reload').addEventListener('click', () => { load().catch(showError); });
  const showError = (e) => { $('updated').textContent = 'refresh failed: ' + e.message; };
  load().catch(showError);
  setInterval(() => { if (document.visibilityState === 'visible') load().catch(showError); }, 30000);
  setInterval(tick, 5000);
})();
</script>
</body>
</html>
`;
