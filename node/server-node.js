/**
 * server-node.js — Lorl Server Host (Node.js / cloud)
 * 
 * Works on: Fly.io, Railway, Render, Heroku, any VPS, local machine
 * 
 * Install: npm install ws
 * Run:     node server-node.js
 * 
 * Environment variables:
 *   PORT        - port to listen on (default: 8080)
 *   MAX_PLAYERS - max players per room (default: 50)
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT || '8080');
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '50');

// rooms[gameId__roomId] = Map(playerId -> { ws, username, data })
const rooms = new Map();

function getRoom(gameId, roomId) {
  const key = `${gameId}__${roomId}`;
  if (!rooms.has(key)) rooms.set(key, new Map());
  return { room: rooms.get(key), key };
}

function cleanEmpty() {
  rooms.forEach((room, key) => {
    if (room.size === 0) rooms.delete(key);
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function broadcast(room, msg, excludeId) {
  const str = JSON.stringify(msg);
  room.forEach((session, id) => {
    if (id !== excludeId && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.send(str); } catch (_) {}
    }
  });
}

// ── HTTP Server ──
const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    server: 'Lorl Server Host',
    version: '1.0.0',
    status: 'online',
    rooms: rooms.size,
    players: [...rooms.values()].reduce((a, r) => a + r.size, 0),
  }));
});

// ── WebSocket Server ──
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const gameId = url.searchParams.get('game') || 'unknown';
  const roomId = url.searchParams.get('room') || 'default';
  const { room, key: roomKey } = getRoom(gameId, roomId);

  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (msg.type) {
      case 'join': {
        playerId = msg.playerId;
        const username = msg.username || 'Player';

        if (room.size >= MAX_PLAYERS) {
          sendTo(ws, { type: 'error', message: 'Room is full' });
          ws.close();
          return;
        }

        // Send current room state to joining player
        const playersList = [];
        room.forEach((s, id) => {
          playersList.push({ id, username: s.username, data: s.data });
        });
        sendTo(ws, { type: 'room_state', players: playersList });

        // Add to room
        room.set(playerId, { ws, username, data: {} });

        // Announce
        broadcast(room, { type: 'player_joined', playerId, username }, playerId);

        console.log(`[${roomKey}] ${username} (${playerId}) joined — ${room.size} players`);
        break;
      }

      case 'state_update': {
        const session = playerId && room.get(playerId);
        if (!session) return;
        session.data = { ...session.data, ...msg.data };
        broadcast(room, { type: 'state_update', playerId, username: session.username, data: msg.data }, playerId);
        break;
      }

      case 'custom': {
        broadcast(room, { type: 'custom', playerId, event: msg.event, data: msg.data }, playerId);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    const session = room.get(playerId);
    if (session) {
      room.delete(playerId);
      broadcast(room, { type: 'player_left', playerId, username: session.username }, null);
      console.log(`[${roomKey}] ${session.username} left — ${room.size} players`);
    }
    cleanEmpty();
  });

  ws.on('error', () => {
    if (playerId) room.delete(playerId);
    cleanEmpty();
  });

  // Ping/pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat to clean dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║       Lorl Server Host (Node.js)      ║
╠═══════════════════════════════════════╣
║  Listening on  ws://localhost:${PORT.toString().padEnd(6)} ║
║  Max players   ${MAX_PLAYERS.toString().padEnd(23)} ║
╚═══════════════════════════════════════╝
  `);
});
