/**
 * server-node.js — Lorl Server Host (Node.js / cloud)
 *
 * Works on: Fly.io, Railway, Render, Heroku, any VPS, local machine
 *
 * Install: npm install ws
 * Run:     node server-node.js
 *
 * Environment variables:
 *   PORT           - port to listen on          (default: 8080)
 *   MAX_PLAYERS    - max players per room/lobby  (default: 50)
 *   MAX_MSG_SIZE   - max incoming message bytes  (default: 65536)
 *   MAX_LOBBIES    - max lobbies per game        (default: 100)
 */

'use strict';

const WebSocket = require('ws');
const http      = require('http');

const PORT         = parseInt(process.env.PORT          || '8080');
const MAX_PLAYERS  = parseInt(process.env.MAX_PLAYERS   || '50');
const MAX_MSG_SIZE = parseInt(process.env.MAX_MSG_SIZE  || '65536');   // 64 KB
const MAX_LOBBIES  = parseInt(process.env.MAX_LOBBIES   || '100');

// ─────────────────────────────────────────────
// Data structures
// ─────────────────────────────────────────────

/**
 * rooms  — legacy direct-join rooms (no lobby browser)
 *   key: `${gameId}__${roomId}`
 *   val: Map(playerId → session)
 *
 * lobbies — named, optionally public rooms
 *   key: `${gameId}__${lobbyId}`
 *   val: {
 *     id, gameId, name, isPublic, maxPlayers,
 *     ownerId, createdAt,
 *     players: Map(playerId → session)
 *   }
 *
 * session: { ws, username, data, joinedAt }
 */
const rooms   = new Map();  // legacy rooms
const lobbies = new Map();  // lobby-based rooms

// Simple per-IP rate limiting: track message timestamps
const ipMsgLog = new Map(); // ip → [timestamps]
const RATE_LIMIT_WINDOW = 1000; // ms
const RATE_LIMIT_MAX    = 60;   // messages per window

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function safeStr(val, maxLen = 64) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen).replace(/[<>"'`]/g, '');
}

function safeId(val) {
  // Only allow alphanumeric, underscore, hyphen
  return String(val || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 80);
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

function sendErr(ws, message) {
  sendTo(ws, { type: 'error', message });
}

function broadcast(playerMap, msg, excludeId = null) {
  const str = JSON.stringify(msg);
  playerMap.forEach((session, id) => {
    if (id !== excludeId && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.send(str); } catch (_) {}
    }
  });
}

function lobbyKey(gameId, lobbyId) { return `${gameId}__${lobbyId}`; }

function getLobbyInfo(lobby) {
  return {
    id:         lobby.id,
    name:       lobby.name,
    gameId:     lobby.gameId,
    isPublic:   lobby.isPublic,
    playerCount: lobby.players.size,
    maxPlayers: lobby.maxPlayers,
    ownerId:    lobby.ownerId,
    createdAt:  lobby.createdAt,
  };
}

function cleanEmpty() {
  rooms.forEach((room, key) => { if (room.size === 0) rooms.delete(key); });
  // Lobbies are not auto-deleted when empty — they persist until owner leaves or closes.
  // But if owner is gone and lobby is empty, clean up.
  lobbies.forEach((lobby, key) => {
    if (lobby.players.size === 0) lobbies.delete(key);
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const log = ipMsgLog.get(ip) || [];
  // Remove old entries
  const recent = log.filter(t => now - t < RATE_LIMIT_WINDOW);
  recent.push(now);
  ipMsgLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// ─────────────────────────────────────────────
// HTTP health endpoint
// ─────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost`);

  // GET /lobbies?game=<gameId>  — list public lobbies for a game
  if (url.pathname === '/lobbies') {
    const gameId = safeId(url.searchParams.get('game') || '');
    const result = [];
    lobbies.forEach((lobby) => {
      if (lobby.gameId === gameId && lobby.isPublic) {
        result.push(getLobbyInfo(lobby));
      }
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ lobbies: result }));
    return;
  }

  // GET / — server status
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    server:       'Lorl Server Host',
    version:      '2.0.0',
    status:       'online',
    rooms:        rooms.size,
    lobbies:      lobbies.size,
    players:      [...rooms.values(), ...([...lobbies.values()].map(l => l.players))]
                    .reduce((a, m) => a + m.size, 0),
  }));
});

// ─────────────────────────────────────────────
// WebSocket server
// ─────────────────────────────────────────────

const wss = new WebSocket.Server({ server, maxPayload: MAX_MSG_SIZE });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // Connection state for this socket
  let playerId  = null;
  let currentLobbyKey = null; // if in a lobby
  let currentRoomKey  = null; // if in a legacy room

  // ── helpers scoped to this connection ──

  function getPlayerLobby() {
    return currentLobbyKey ? lobbies.get(currentLobbyKey) : null;
  }

  function leaveCurrentContext(reason = 'left') {
    // Leave lobby
    if (currentLobbyKey) {
      const lobby = lobbies.get(currentLobbyKey);
      if (lobby && playerId) {
        const session = lobby.players.get(playerId);
        lobby.players.delete(playerId);
        broadcast(lobby.players, {
          type: 'lobby_player_left',
          playerId,
          username: session && session.username,
          reason,
        });
        // If owner left, transfer ownership or close lobby
        if (lobby.ownerId === playerId) {
          if (lobby.players.size > 0) {
            const newOwner = lobby.players.keys().next().value;
            lobby.ownerId = newOwner;
            broadcast(lobby.players, { type: 'lobby_owner_changed', newOwnerId: newOwner });
          }
        }
        console.log(`[lobby:${currentLobbyKey}] ${playerId} left — ${lobby.players.size} remaining`);
      }
      currentLobbyKey = null;
    }

    // Leave legacy room
    if (currentRoomKey) {
      const room = rooms.get(currentRoomKey);
      if (room && playerId) {
        const session = room.get(playerId);
        if (session) {
          room.delete(playerId);
          broadcast(room, { type: 'player_left', playerId, username: session.username }, null);
          console.log(`[room:${currentRoomKey}] ${session.username} left — ${room.size} remaining`);
        }
      }
      currentRoomKey = null;
    }

    cleanEmpty();
  }

  // ── message handler ──

  ws.on('message', (raw) => {
    // Rate limit
    if (isRateLimited(ip)) {
      sendErr(ws, 'Rate limit exceeded');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      sendErr(ws, 'Invalid JSON');
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {

      // ═══════════════════════════════════════
      // LOBBY MESSAGES
      // ═══════════════════════════════════════

      case 'lobby_create': {
        const gameId    = safeId(msg.gameId || 'unknown');
        const lobbyName = safeStr(msg.lobbyName || 'My Lobby', 64);
        const lobbyId   = safeId(msg.lobbyId || ('lby_' + Math.random().toString(36).slice(2, 9)));
        const maxP      = Math.min(Math.max(parseInt(msg.maxPlayers) || MAX_PLAYERS, 2), MAX_PLAYERS);
        const pId       = safeId(msg.playerId || ('p_' + Math.random().toString(36).slice(2, 9)));
        const username  = safeStr(msg.username || 'Player', 32);

        // lobbyName starting with PUBLIC_ → public lobby
        const isPublic  = lobbyName.startsWith('PUBLIC_');

        // Count existing lobbies for this game
        let gameLobbiesCount = 0;
        lobbies.forEach(l => { if (l.gameId === gameId) gameLobbiesCount++; });
        if (gameLobbiesCount >= MAX_LOBBIES) {
          sendErr(ws, 'Too many lobbies for this game');
          return;
        }

        const key = lobbyKey(gameId, lobbyId);
        if (lobbies.has(key)) {
          sendErr(ws, 'Lobby ID already exists');
          return;
        }

        leaveCurrentContext('left_to_create');

        playerId        = pId;
        currentLobbyKey = key;

        const lobby = {
          id:         lobbyId,
          gameId,
          name:       lobbyName,
          isPublic,
          maxPlayers: maxP,
          ownerId:    playerId,
          createdAt:  Date.now(),
          players:    new Map(),
        };
        lobby.players.set(playerId, { ws, username, data: {}, joinedAt: Date.now() });
        lobbies.set(key, lobby);

        sendTo(ws, {
          type:    'lobby_created',
          lobbyId,
          lobbyName,
          isPublic,
          maxPlayers: maxP,
          playerId,
        });

        console.log(`[lobby:${key}] Created by ${username} (${playerId}), public=${isPublic}`);
        break;
      }

      case 'lobby_join': {
        const gameId   = safeId(msg.gameId || 'unknown');
        const lobbyId  = safeId(msg.lobbyId || '');
        const pId      = safeId(msg.playerId || ('p_' + Math.random().toString(36).slice(2, 9)));
        const username = safeStr(msg.username || 'Player', 32);

        const key   = lobbyKey(gameId, lobbyId);
        const lobby = lobbies.get(key);

        if (!lobby) {
          sendErr(ws, 'Lobby not found');
          return;
        }
        if (lobby.players.size >= lobby.maxPlayers) {
          sendErr(ws, 'Lobby is full');
          return;
        }

        leaveCurrentContext('left_to_join');

        playerId        = pId;
        currentLobbyKey = key;

        // Send current lobby state to joiner
        const playersList = [];
        lobby.players.forEach((s, id) => playersList.push({ id, username: s.username, data: s.data }));
        sendTo(ws, {
          type:       'lobby_state',
          lobbyId,
          lobbyName:  lobby.name,
          isPublic:   lobby.isPublic,
          ownerId:    lobby.ownerId,
          maxPlayers: lobby.maxPlayers,
          players:    playersList,
          playerId,
        });

        // Announce to existing players
        broadcast(lobby.players, {
          type:     'lobby_player_joined',
          playerId,
          username,
        });

        lobby.players.set(playerId, { ws, username, data: {}, joinedAt: Date.now() });

        console.log(`[lobby:${key}] ${username} (${playerId}) joined — ${lobby.players.size} players`);
        break;
      }

      case 'lobby_leave': {
        leaveCurrentContext('left');
        sendTo(ws, { type: 'lobby_left' });
        break;
      }

      case 'lobby_list': {
        // Return public lobbies for a game
        const gameId = safeId(msg.gameId || '');
        const result = [];
        lobbies.forEach((lobby) => {
          if (lobby.gameId === gameId && lobby.isPublic) {
            result.push(getLobbyInfo(lobby));
          }
        });
        sendTo(ws, { type: 'lobby_list', lobbies: result });
        break;
      }

      case 'lobby_kick': {
        // Only the owner can kick
        const lobby = getPlayerLobby();
        if (!lobby || lobby.ownerId !== playerId) {
          sendErr(ws, 'Not the lobby owner');
          return;
        }
        const targetId = safeId(msg.targetId || '');
        const target   = lobby.players.get(targetId);
        if (!target) {
          sendErr(ws, 'Player not in lobby');
          return;
        }
        sendTo(target.ws, { type: 'lobby_kicked', reason: 'Kicked by host' });
        lobby.players.delete(targetId);
        broadcast(lobby.players, { type: 'lobby_player_left', playerId: targetId, reason: 'kicked' });
        break;
      }

      case 'lobby_close': {
        // Only the owner can close the lobby
        const lobby = getPlayerLobby();
        if (!lobby || lobby.ownerId !== playerId) {
          sendErr(ws, 'Not the lobby owner');
          return;
        }
        broadcast(lobby.players, { type: 'lobby_closed' }, playerId);
        lobby.players.forEach(s => { try { s.ws.close(); } catch (_) {} });
        lobbies.delete(currentLobbyKey);
        currentLobbyKey = null;
        sendTo(ws, { type: 'lobby_closed' });
        break;
      }

      // ═══════════════════════════════════════
      // SHARED: state update & custom messages
      //   — works in both lobbies and legacy rooms
      // ═══════════════════════════════════════

      case 'state_update': {
        const session = getSessionInContext();
        if (!session) return;
        session.data = { ...session.data, ...sanitizeData(msg.data) };
        broadcastInContext({ type: 'state_update', playerId, username: session.username, data: msg.data }, playerId);
        break;
      }

      case 'custom': {
        const event = safeStr(msg.event || '', 64);
        if (!event) return;
        broadcastInContext({ type: 'custom', playerId, event, data: sanitizeData(msg.data) }, playerId);
        break;
      }

      // ═══════════════════════════════════════
      // LEGACY ROOM MESSAGES (backwards compat)
      // ═══════════════════════════════════════

      case 'join': {
        const gameId  = safeId(msg.gameId || 'unknown');
        const roomId  = safeId(msg.roomId || 'default');
        const pId     = safeId(msg.playerId || ('p_' + Math.random().toString(36).slice(2, 9)));
        const uname   = safeStr(msg.username || 'Player', 32);

        leaveCurrentContext('left_to_join');

        const key = `${gameId}__${roomId}`;
        if (!rooms.has(key)) rooms.set(key, new Map());
        const room = rooms.get(key);

        if (room.size >= MAX_PLAYERS) {
          sendErr(ws, 'Room is full');
          ws.close();
          return;
        }

        playerId       = pId;
        currentRoomKey = key;

        // Send current room state to joining player
        const playersList = [];
        room.forEach((s, id) => playersList.push({ id, username: s.username, data: s.data }));
        sendTo(ws, { type: 'room_state', players: playersList });

        room.set(playerId, { ws, username: uname, data: {}, joinedAt: Date.now() });
        broadcast(room, { type: 'player_joined', playerId, username: uname }, playerId);

        console.log(`[room:${key}] ${uname} (${playerId}) joined — ${room.size} players`);
        break;
      }

      default:
        // Unknown message type — ignore silently
        break;
    }
  });

  // ── Helper: get session in whatever context we're in ──
  function getSessionInContext() {
    if (currentLobbyKey) {
      const lobby = lobbies.get(currentLobbyKey);
      return lobby && playerId ? lobby.players.get(playerId) : null;
    }
    if (currentRoomKey) {
      const room = rooms.get(currentRoomKey);
      return room && playerId ? room.get(playerId) : null;
    }
    return null;
  }

  function broadcastInContext(msg, excludeId = null) {
    if (currentLobbyKey) {
      const lobby = lobbies.get(currentLobbyKey);
      if (lobby) broadcast(lobby.players, msg, excludeId);
    } else if (currentRoomKey) {
      const room = rooms.get(currentRoomKey);
      if (room) broadcast(room, msg, excludeId);
    }
  }

  // ── Sanitize arbitrary data payloads (shallow, size-limited) ──
  function sanitizeData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    let keys = 0;
    for (const k in data) {
      if (keys++ > 32) break; // max 32 keys
      const v = data[k];
      if (typeof v === 'string')  out[k] = v.slice(0, 256);
      else if (typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
      else if (v === null) out[k] = null;
      // nested objects/arrays discarded for safety
    }
    return out;
  }

  // ── Cleanup on disconnect ──
  ws.on('close', () => {
    leaveCurrentContext('disconnected');
  });

  ws.on('error', () => {
    leaveCurrentContext('error');
  });

  // Ping/pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat — kill dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

// Periodically flush stale IP rate limit logs
setInterval(() => {
  const now = Date.now();
  ipMsgLog.forEach((log, ip) => {
    const fresh = log.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (fresh.length === 0) ipMsgLog.delete(ip);
    else ipMsgLog.set(ip, fresh);
  });
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║       LORL Server Host (Node.js) v2      ║
╠══════════════════════════════════════════╣
║  Listening on  ws://YOUR-IP:${String(PORT).padEnd(6)}     ║
║  Max players   ${String(MAX_PLAYERS).padEnd(26)} ║
║  Max lobbies   ${String(MAX_LOBBIES).padEnd(26)} ║
╚══════════════════════════════════════════╝
  `);
});
