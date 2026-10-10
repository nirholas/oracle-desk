// The desk's dashboard: static files from web/, a JSON snapshot, a live event
// stream, and a small control surface.
//
// Binds to 127.0.0.1 by default. Control requests must come from the
// dashboard's own origin, so a web page elsewhere cannot drive the desk through
// the operator's browser.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './config.js';

const WEB = join(ROOT, 'web');
const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.json': 'application/json',
};
const STATE_PUSH_MS = 2_000;

function send(res, status, body, type = 'application/json') {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

/** True when the request's Origin (or Referer) is this server. */
export function sameOrigin(req) {
	const host = req.headers.host;
	const origin = req.headers.origin || req.headers.referer;
	if (!host || !origin) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

async function readBody(req, limit = 4096) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
		chunks.push(chunk);
	}
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function serveStatic(req, res) {
	const path = new URL(req.url, 'http://x').pathname;
	const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
	const file = join(WEB, rel);
	if (!file.startsWith(WEB + sep)) return send(res, 403, { error: 'forbidden' });
	try {
		const body = await readFile(file);
		res.writeHead(200, {
			'content-type': TYPES[extname(file)] || 'application/octet-stream',
			'cache-control': extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
			'x-content-type-options': 'nosniff',
		});
		res.end(body);
	} catch {
		send(res, 404, { error: 'not found' });
	}
}

function stream(desk, req, res) {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
	});
	const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	write('state', desk.snapshot());
	const onLog = (entry) => write('log', entry);
	desk.bus.on('log', onLog);
	const timer = setInterval(() => write('state', desk.snapshot()), STATE_PUSH_MS);
	req.on('close', () => {
		clearInterval(timer);
		desk.bus.off('log', onLog);
	});
}

async function control(desk, req, res) {
	if (!sameOrigin(req)) return send(res, 403, { error: 'controls only accept requests from the dashboard itself' });
	const body = await readBody(req);
	switch (body.action) {
		case 'pause':
			desk.risk.paused = true;
			desk.bus.note('SYSTEM', 'OPERATOR', 'desk paused: no new entries, exits keep running', { kind: 'pause' });
			break;
		case 'resume':
			desk.risk.paused = false;
			desk.bus.note('SYSTEM', 'OPERATOR', 'desk resumed', { kind: 'resume' });
			break;
		case 'close':
			if (typeof body.mint !== 'string') return send(res, 400, { error: 'mint required' });
			await desk.execution.close(body.mint);
			break;
		case 'review':
			await desk.head.review();
			break;
		default:
			return send(res, 400, { error: 'unknown action' });
	}
	desk.save();
	return send(res, 200, { ok: true, paused: desk.risk.paused });
}

export function startServer(desk, { host, port }) {
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url, 'http://x').pathname;
			if (path === '/api/state' && req.method === 'GET') return send(res, 200, desk.snapshot());
			if (path === '/api/events' && req.method === 'GET') return stream(desk, req, res);
			if (path === '/api/control' && req.method === 'POST') return await control(desk, req, res);
			if (req.method === 'GET') return await serveStatic(req, res);
			return send(res, 405, { error: 'method not allowed' });
		} catch (err) {
			return send(res, err.status || 500, { error: err.message });
		}
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}
