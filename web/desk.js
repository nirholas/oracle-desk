// Oracle Desk dashboard. One event stream from the local desk process: a full
// snapshot every two seconds and every log line as it happens. Each section
// re-renders only when its own data changed, so focus and scroll stay put.

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, d = 4) => (n == null || !Number.isFinite(Number(n)) ? '-' : Number(n).toFixed(d));
const signed = (n, d = 4) => (n == null ? '-' : `${n > 0 ? '+' : ''}${fmt(n, d)}`);
const tone = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : '');
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ago = (t) => {
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const until = (t) => {
	const s = Math.max(0, Math.round((t - Date.now()) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};
const oracleCoin = (mint) => `https://three.ws/oracle/coin/${encodeURIComponent(mint)}`;
const solscan = (sig) => `https://solscan.io/tx/${encodeURIComponent(sig)}`;

let state = null;
const rendered = {};
let lastSeenFired = null;

function renderIf(key, data, fn) {
	const sig = JSON.stringify(data);
	if (rendered[key] === sig) return;
	rendered[key] = sig;
	fn(data);
}

function coinCell(mint, symbol, image) {
	const sym = symbol || mint.slice(0, 6);
	const img = image ? `<img class="coin-img" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="coin-img" aria-hidden="true">${esc(sym.slice(0, 1))}</span>`;
	return `<div class="coin-cell">${img}<a class="coin-sym" href="${oracleCoin(mint)}" target="_blank" rel="noopener" title="Open ${esc(sym)} on the Oracle">${esc(sym)}</a></div>`;
}

function tierPill(tier) {
	return tier ? `<span class="tierpill tp-${esc(tier)}">${esc(tier)}</span>` : '';
}

/* ── hero ─────────────────────────────────────────────────────────────── */

function renderHero(s) {
	const pill = $('modePill');
	pill.dataset.mode = s.mode;
	pill.textContent = s.mode === 'live' ? 'Live' : 'Paper';
	pill.title = s.mode === 'live' ? `Trading real funds from ${s.address}` : 'Real launches and real quotes; nothing is signed';
	$('liveDot').classList.remove('off');
	const up = ago(s.started_at);
	$('eyebrowText').textContent = `${s.mode === 'live' ? 'live' : 'paper'} desk · up ${up}${s.risk.paused ? ' · paused' : ''}${s.risk.frozen ? ' · frozen' : ''}`;

	const w = s.wallet;
	const winRate = s.record.trades ? Math.round((s.record.wins / s.record.trades) * 100) : null;
	const stats = [
		['Equity', `${fmt(w.equity_sol, 3)}`, `started ${fmt(w.start_sol, 2)} SOL`, ''],
		['Net P&L', signed(w.net_sol, 3), `today ${signed(w.realized_today_sol, 3)} realized`, tone(w.net_sol)],
		['Wallet', fmt(w.wallet_sol, 3), `${fmt(w.mark_sol, 3)} SOL in positions`, ''],
		['Vault', fmt(w.vault_sol, 3), 'swept profit', ''],
		['Win / loss', `${s.record.wins}/${s.record.losses}`, winRate == null ? 'no closed trades yet' : `${winRate}% of ${s.record.trades}`, ''],
		['Launches', s.counters.launches.toLocaleString(), `${s.counters.verdicts.toLocaleString()} Oracle verdicts`, ''],
	];
	renderIf('stats', stats, (rows) => {
		$('statline').innerHTML = rows
			.map(([label, value, sub, cls]) => `<div class="stat"><span>${esc(label)}</span><b class="${cls}">${esc(value)}</b><span class="stat-sub">${esc(sub)}</span></div>`)
			.join('');
	});

	const pause = $('pauseBtn');
	pause.disabled = false;
	pause.setAttribute('aria-pressed', String(s.risk.paused));
	pause.textContent = s.risk.paused ? 'Resume entries' : 'Pause entries';
	$('reviewBtn').disabled = false;
}

/* ── funnel ───────────────────────────────────────────────────────────── */

const KILL_LABEL = {
	min_score: 'conviction too low',
	max_rug_risk: 'rug risk too high',
	max_give_back: 'give-back risk too high',
	min_momentum: 'momentum too weak',
	min_structure: 'structure too weak',
	min_pedigree: 'pedigree too weak',
	min_smart_wallets: 'no smart wallets',
	max_age_s: 'too old by the time scored',
};

function renderFunnel(s) {
	const c = s.counters;
	const steps = [
		['Launches seen', c.launches],
		['Oracle verdicts', c.verdicts],
		['Cleared research', c.cleared],
		['Entries taken', c.entries],
		['Closed and graded', c.closed],
	];
	renderIf('funnel', { steps, blocked: c.blocked, fw: c.firewalled, killed: s.killed_by }, ({ steps: rows, blocked, fw, killed }) => {
		const max = Math.max(1, ...rows.map((r) => r[1]));
		$('funnel').innerHTML = rows
			.map(([label, n]) => {
				const pct = n ? Math.max(0.6, Math.sqrt(n / max) * 100) : 0;
				return `<li><span class="fl-lab">${esc(label)}</span><span class="fl-track" aria-hidden="true"><span class="fl-fill" style="width:${pct.toFixed(1)}%"></span></span><span class="fl-val">${n.toLocaleString()}</span></li>`;
			})
			.join('');
		const kills = Object.entries(killed || {}).sort((a, b) => b[1] - a[1]);
		const chips = [
			...kills.map(([k, n]) => `<span class="chip">${esc(KILL_LABEL[k] || k)} <b>${n.toLocaleString()}</b></span>`),
			blocked ? `<span class="chip">refused by risk <b>${blocked.toLocaleString()}</b></span>` : '',
			fw ? `<span class="chip">refused by firewall <b>${fw.toLocaleString()}</b></span>` : '',
		].filter(Boolean);
		$('kills').innerHTML = chips.length ? chips.join('') : '<span class="chip">Waiting for the first verdicts to come through research</span>';
	});
}

/* ── org chart ────────────────────────────────────────────────────────── */

function agentRow(a, meta) {
	const cls = a.status === 'live' ? 'live' : a.status === 'error' ? 'error' : a.status === 'reconnecting' || a.status === 'connecting' ? 'warn' : '';
	return `<div class="agent"><span class="dot ${cls}" aria-hidden="true"></span><span>${esc(a.name)} <span class="meta">${esc(a.status)}</span></span><span class="meta">${esc(meta)}</span></div>`;
}

const BAR_LABEL = { min_score: 'score ≥', max_rug_risk: 'rug ≤', max_give_back: 'give-back ≤', min_momentum: 'momentum ≥', min_structure: 'structure ≥', min_pedigree: 'pedigree ≥', min_smart_wallets: 'smart ≥', max_age_s: 'age ≤' };

function seatCard(seat) {
	const g = seat.grade;
	const bars = Object.entries(seat.checks)
		.map(([k, v]) => `<span class="bar-chip">${esc(BAR_LABEL[k] || k)} <b>${k === 'max_age_s' ? `${Math.round(v / 60)}m` : esc(v)}</b></span>`)
		.join('');
	const scoreTone = g.n ? (g.score >= 0.5 ? 'gain' : 'loss') : 'dim';
	return `<div class="seat" data-seat="${esc(seat.id)}">
		<div class="seat-top"><span class="seat-id">${esc(seat.id)}</span><span class="seat-rev">rev ${seat.rev}</span>${seat.fired ? `<span class="badge-fired">fired ${seat.fired}x</span>` : ''}<span class="seat-score ${scoreTone}" title="Seat grade over its current window: half smoothed win rate, half return on what it risked">${g.n ? g.score.toFixed(2) : '-'}</span></div>
		<p class="seat-thesis">${esc(seat.thesis)}</p>
		<div class="seat-stats"><span class="chip">${g.wins}/${g.n} wins</span><span class="chip ${tone(g.netLamports)}">${signed(g.netLamports / 1e9, 3)} SOL</span><span class="chip">budget <b>${seat.budget}x</b></span><span class="chip">cleared <b>${seat.stats.claimed}</b></span></div>
		<div class="bars">${bars}</div>
	</div>`;
}

function renderOrg(s) {
	renderIf('org', { tick: Math.floor(Date.now() / 30_000), radar: s.radar, seats: s.seats, risk: s.risk, exec: s.execution, audit: s.audit, treasury: s.treasury, pos: s.positions.filter((p) => p.status === 'open').length, w: s.wallet }, (d) => {
		const openCap = d.risk.caps.max_open_positions;
		const lossUsed = Math.max(0, -Math.min(0, d.w.realized_today_sol));
		const lossPct = Math.min(100, (lossUsed / d.risk.caps.daily_loss_cap_sol) * 100);
		const blocks = Object.entries(d.risk.blocks).sort((a, b) => b[1] - a[1]).slice(0, 3);
		const revs = d.audit.revisions.slice(0, 3);
		$('org').innerHTML = `
		<article class="card" aria-label="Radar desk">
			<div class="desk-top"><span class="desk-no">01</span><span class="desk-name">RADAR</span></div>
			<p class="desk-role">Every pump.fun launch and every Oracle verdict, the moment they happen.</p>
			<div class="agents">${d.radar.map((a) => agentRow(a, `${a.count.toLocaleString()} seen`)).join('')}</div>
		</article>
		<article class="card research" aria-label="Research desk">
			<div class="desk-top"><span class="desk-no">02</span><span class="desk-name">RESEARCH</span></div>
			<p class="desk-role">Four seats judge every verdict. The seat with the widest margin claims the coin and owns the result.</p>
			<div class="seats">${d.seats.map(seatCard).join('')}</div>
		</article>
		<article class="card" aria-label="Execution desk">
			<div class="desk-top"><span class="desk-no">03</span><span class="desk-name">EXECUTION</span></div>
			<p class="desk-role">Quotes the bonding curve or PumpSwap pool, runs the firewall, takes the fill, works the exit ladder.</p>
			<div class="agents">${d.exec.map((a) => agentRow(a, `${a.fills} fills${a.failures ? ` · ${a.failures} failed` : ''}${a.last_ms ? ` · ${a.last_ms}ms` : ''}`)).join('')}</div>
		</article>
		<article class="card" aria-label="Risk desk">
			<div class="desk-top"><span class="desk-no">04</span><span class="desk-name">RISK</span>${d.risk.frozen ? '<span class="frozen">frozen</span>' : d.risk.paused ? '<span class="frozen">paused</span>' : ''}</div>
			<p class="desk-role">Sizes every entry and can refuse any of them. Nobody overrides it.</p>
			<dl class="kv"><dt>Open positions</dt><dd>${d.pos} / ${openCap}</dd></dl>
			<div class="meter${d.pos >= openCap ? ' hot' : ''}" role="img" aria-label="${d.pos} of ${openCap} position slots used"><i style="width:${Math.min(100, (d.pos / openCap) * 100)}%"></i></div>
			<dl class="kv"><dt>Daily loss used</dt><dd>${fmt(lossUsed, 3)} / ${d.risk.caps.daily_loss_cap_sol} SOL</dd></dl>
			<div class="meter${lossPct > 75 ? ' hot' : ''}" role="img" aria-label="${Math.round(lossPct)}% of the daily loss cap used"><i style="width:${lossPct}%"></i></div>
			<dl class="kv"><dt>Entry size</dt><dd>${d.risk.caps.base_size_sol} SOL x budget</dd><dt>Max per position</dt><dd>${Math.round(d.risk.caps.max_position_fraction * 100)}% of wallet</dd></dl>
			${blocks.length ? `<div class="bars">${blocks.map(([k, n]) => `<span class="bar-chip">${esc(k)} <b>${n}</b></span>`).join('')}</div>` : ''}
		</article>
		<article class="card" aria-label="Audit desk">
			<div class="desk-top"><span class="desk-no">05</span><span class="desk-name">AUDIT</span></div>
			<p class="desk-role">Grades every closed trade and moves the seat's closest call one step, inside hard clamps.</p>
			<div class="agents">${d.audit.agents.map((a) => agentRow(a, a.graded != null ? `${a.graded} graded` : `${a.revisions} revisions`)).join('')}</div>
			${revs.length ? revs.map((r) => `<div class="bar-chip">${esc(r.seat)} ${esc(r.key)} <b>${esc(r.from)} → ${esc(r.to)}</b></div>`).join('') : '<p class="desk-role">No revisions yet. The matrix moves after the first graded trade.</p>'}
		</article>
		<article class="card" aria-label="Treasury desk">
			<div class="desk-top"><span class="desk-no">06</span><span class="desk-name">TREASURY</span>${d.treasury.frozen ? '<span class="frozen">freeze on</span>' : ''}</div>
			<p class="desk-role">Freezes new entries on a real drawdown and sweeps profit out of the hot wallet.</p>
			<dl class="kv"><dt>Vault</dt><dd>${fmt(d.w.vault_sol, 4)} SOL</dd><dt>Next sweep</dt><dd>in ${until(d.treasury.next_sweep_at)}</dd><dt>Sweeps</dt><dd>${d.treasury.sweeps.length}</dd></dl>
		</article>`;
	});
}

function renderHead(s) {
	renderIf('head', { tick: Math.floor(Date.now() / 30_000), head: s.head, memo: s.memo_enabled, seats: s.seats.map((x) => [x.id, x.fired]) }, ({ head, memo }) => {
		const latest = head.decisions.slice(0, 4);
		const m = head.memos[0];
		$('headCard').innerHTML = `
		<div>
			<div class="head-title"><span class="desk-name">HEAD OF DESK</span><span class="chip">never trades</span></div>
			<p class="desk-role">Reads every seat's realized record each review. Promotes the best, fires the worst below the bar, and has audit rewrite the fired seat from its own trades.</p>
			<dl class="kv" style="margin-top:12px"><dt>Next review</dt><dd>in ${until(head.next_review_at)}</dd><dt>Firings</dt><dd>${head.firings}</dd></dl>
			${m ? `<div class="memo"><span class="memo-meta">memo · ${esc(time(m.t))} · ${esc(m.model)}</span>${esc(m.text)}</div>` : memo ? '' : '<p class="desk-role" style="margin-top:12px">Set ANTHROPIC_API_KEY and the head writes a short memo narrating each review. Decisions never depend on it.</p>'}
		</div>
		<div>${latest.length ? latest.map((d) => `<div class="decision"><span class="k ${esc(d.kind)}">${esc(d.kind)}</span>${d.seat ? `<b>${esc(d.seat)}</b> ` : ''}${esc(d.text)}</div>`).join('') : '<div class="empty"><b>No review yet</b>The first review runs one interval after start, or run one now from the button above.</div>'}</div>`;
	});
	const fired = s.head.decisions.find((d) => d.kind === 'fire');
	if (fired && lastSeenFired !== null && fired.t !== lastSeenFired) {
		document.querySelector(`.seat[data-seat="${CSS.escape(fired.seat)}"]`)?.classList.add('fired-now');
	}
	lastSeenFired = fired?.t ?? 0;
}

/* ── positions and trades ─────────────────────────────────────────────── */

function renderPositions(s) {
	renderIf('positions', s.positions, (rows) => {
		$('posCount').textContent = rows.length ? rows.length : '';
		if (!rows.length) {
			const last = s.recent_clears[0];
			$('positions').innerHTML = `<div class="empty"><b>No open positions</b>The desk enters when a seat clears a coin and risk allows it.${last ? ` Last clear: ${esc(last.symbol || last.mint.slice(0, 6))} by ${esc(last.seat)}, ${esc(ago(last.t))} ago.` : ' Nothing has cleared research yet this session.'}</div>`;
			return;
		}
		$('positions').innerHTML = `<table><thead><tr><th>Coin</th><th>Seat</th><th>Status</th><th class="num">Cost</th><th class="num">Value</th><th class="num">Multiple</th><th class="num">Oracle</th><th class="num">P(run &amp; hold)</th><th>Held</th><th></th></tr></thead><tbody>${rows
			.map(
				(p) => `<tr>
			<td>${coinCell(p.mint, p.symbol, p.image)}</td>
			<td class="mono">${esc(p.seat)}</td>
			<td><span class="status ${esc(p.status)}">${p.status === 'bag' ? 'bag' : p.initials_recovered ? 'stake back' : 'open'}</span> <span class="dim mono">${p.venue === 'amm' ? 'pool' : 'curve'}</span></td>
			<td class="num">${fmt(p.cost_sol)}</td>
			<td class="num" title="${p.mark_error ? esc(`last mark failed: ${p.mark_error}`) : 'real sell quote'}">${fmt(p.value_sol)}${p.mark_error ? ' <span class="dim">stale</span>' : ''}</td>
			<td class="num ${tone(p.multiple - 1)}">${fmt(p.multiple, 2)}x</td>
			<td class="num">${p.score ?? '-'} ${tierPill(p.tier)}</td>
			<td class="num">${p.p_win == null ? '-' : `${(p.p_win * 100).toFixed(1)}%`}</td>
			<td class="dim mono">${esc(ago(p.opened_at))}</td>
			<td><button class="btn small ghost" type="button" data-close="${esc(p.mint)}" data-symbol="${esc(p.symbol || p.mint.slice(0, 6))}" data-value="${fmt(p.value_sol)}">Sell</button></td>
		</tr>`,
			)
			.join('')}</tbody></table>`;
	});
}

function renderTrades(s) {
	renderIf('trades', s.trades, (rows) => {
		$('tradeCount').textContent = rows.length || '';
		if (!rows.length) {
			$('trades').innerHTML = '<div class="empty"><b>No closed trades yet</b>A trade is graded when its stake-bearing part closes: a stop, a timeout, a dead market, or the ladder returning the stake with a bag left to ride.</div>';
			return;
		}
		$('trades').innerHTML = `<table><thead><tr><th>Coin</th><th>Seat</th><th>Exit</th><th class="num">Cost</th><th class="num">P&amp;L</th><th class="num">Multiple</th><th class="num">Oracle</th><th>Closed</th></tr></thead><tbody>${rows
			.map(
				(t) => `<tr>
			<td>${coinCell(t.mint, t.symbol, null)}</td>
			<td class="mono">${esc(t.seat)}</td>
			<td class="mono dim">${esc(t.reason.replace(/_/g, ' '))}${t.kept_bag ? ' + bag' : ''}</td>
			<td class="num">${fmt(t.cost_sol)}</td>
			<td class="num ${tone(t.pnl_sol)}">${signed(t.pnl_sol)}</td>
			<td class="num">${fmt(t.multiple, 2)}x</td>
			<td class="num">${t.score ?? '-'} ${tierPill(t.tier)}</td>
			<td class="dim mono">${esc(ago(t.closed_at))} ago</td>
		</tr>`,
			)
			.join('')}</tbody></table>`;
	});
}

function renderRecords(s) {
	renderIf('revisions', s.audit.revisions, (rows) => {
		$('revCount').textContent = rows.length || '';
		$('revisions').innerHTML = rows.length
			? rows.map((r) => `<li><time>${esc(time(r.t))}</time><span class="who"><b>${esc(r.seat)}</b></span><span>${esc(r.key)} <b class="mono">${esc(r.from)} → ${esc(r.to)}</b> <span class="dim">${esc(r.why)}</span></span></li>`).join('')
			: '<li><span></span><span></span><span class="dim">No revisions yet. Audit moves a seat\'s bars after it grades a real closed trade.</span></li>';
	});
	renderIf('decisions', s.head.decisions, (rows) => {
		$('decCount').textContent = rows.length || '';
		$('decisions').innerHTML = rows.length
			? rows.map((d) => `<li><time>${esc(time(d.t))}</time><span class="who"><b>${esc(d.kind)}</b></span><span>${d.seat ? `<b>${esc(d.seat)}</b> ` : ''}${esc(d.text)}</span></li>`).join('')
			: '<li><span></span><span></span><span class="dim">The head has not reviewed yet.</span></li>';
	});
	if (s.model) {
		renderIf('model', s.model, (m) => {
			$('modelLine').textContent = `Conviction model v${m.version}: ${m.training_rows.toLocaleString()} labeled launches${m.auc ? `, held-out AUC ${m.auc}` : ''}${m.base_rate ? `, base rate ${(m.base_rate * 100).toFixed(1)}%` : ''}.`;
		});
	}
}

/* ── tape ─────────────────────────────────────────────────────────────── */

const TAPE_LIMIT = 250;
const tapeIds = new Set();

function tapeItem(e, fresh) {
	const li = document.createElement('li');
	li.className = [e.level || '', e.kind ? `k-${e.kind}` : '', fresh ? 'new' : ''].join(' ').trim();
	const sig = e.sig ? ` <a class="sig" href="${solscan(e.sig)}" target="_blank" rel="noopener">tx</a>` : '';
	const coin = e.mint ? ` <a class="sig" href="${oracleCoin(e.mint)}" target="_blank" rel="noopener">oracle</a>` : '';
	li.innerHTML = `<time>${esc(time(e.t))}</time><span class="who">${esc(e.desk)} · ${esc(e.agent)}</span><span class="txt">${esc(e.text)}${sig}${coin}</span>`;
	return li;
}

function addTape(e, fresh = true) {
	if (tapeIds.has(e.id)) return;
	tapeIds.add(e.id);
	const tape = $('tape');
	tape.prepend(tapeItem(e, fresh));
	while (tape.children.length > TAPE_LIMIT) tape.lastElementChild.remove();
}

function seedTape(log) {
	if (tapeIds.size) return;
	for (const e of log) addTape(e, false);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function render(s) {
	state = s;
	renderHero(s);
	renderFunnel(s);
	renderHead(s);
	renderOrg(s);
	renderPositions(s);
	renderTrades(s);
	renderRecords(s);
	seedTape(s.log);
}

function banner(text, info = false) {
	const b = $('banner');
	if (!text) {
		b.hidden = true;
		return;
	}
	b.textContent = text;
	b.classList.toggle('info', info);
	b.hidden = false;
}

function connect() {
	const source = new EventSource('/api/events');
	source.addEventListener('state', (ev) => {
		banner(null);
		render(JSON.parse(ev.data));
	});
	source.addEventListener('log', (ev) => addTape(JSON.parse(ev.data)));
	source.addEventListener('error', () => {
		$('liveDot').classList.add('off');
		$('eyebrowText').textContent = 'reconnecting to the desk';
		banner('Lost the connection to the desk process. Reconnecting on its own; if this stays, check the terminal running oracle-desk.');
	});
}

async function control(body) {
	const res = await fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
	return data;
}

async function withButton(btn, fn) {
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');
	try {
		await fn();
	} catch (err) {
		banner(`That did not go through: ${err.message}`);
	} finally {
		btn.disabled = false;
		btn.removeAttribute('aria-busy');
	}
}

$('pauseBtn').addEventListener('click', (ev) => withButton(ev.currentTarget, () => control({ action: state?.risk.paused ? 'resume' : 'pause' })));
$('reviewBtn').addEventListener('click', (ev) => withButton(ev.currentTarget, () => control({ action: 'review' })));

document.addEventListener('click', (ev) => {
	const btn = ev.target.closest('[data-close]');
	if (!btn) return;
	const dialog = $('confirm');
	const live = state?.mode === 'live';
	$('confirmTitle').textContent = `Sell all of ${btn.dataset.symbol}?`;
	$('confirmBody').textContent = live
		? `This signs a real sale from your wallet for everything left in the position, currently quoted at ${btn.dataset.value} SOL. It cannot be undone.`
		: `This books a paper sale of everything left in the position at the live quote, about ${btn.dataset.value} SOL.`;
	dialog.returnValue = '';
	dialog.showModal();
	dialog.addEventListener(
		'close',
		() => {
			if (dialog.returnValue === 'ok') withButton(btn, () => control({ action: 'close', mint: btn.dataset.close }));
		},
		{ once: true },
	);
});

const tabs = [...document.querySelectorAll('.tab')];
function selectTab(tab) {
	for (const t of tabs) {
		const on = t === tab;
		t.classList.toggle('on', on);
		t.setAttribute('aria-selected', String(on));
		t.tabIndex = on ? 0 : -1;
		const view = $(`view-${t.dataset.view}`);
		view.hidden = !on;
		view.classList.toggle('on', on);
	}
}
for (const tab of tabs) {
	tab.addEventListener('click', () => selectTab(tab));
	tab.addEventListener('keydown', (ev) => {
		if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
		const i = tabs.indexOf(tab);
		const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
		next.focus();
		selectTab(next);
	});
}

connect();
