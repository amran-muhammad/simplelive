const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();

function roomCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(socket, message) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(room, message, except) {
  if (room.host !== except) send(room.host, message);
  for (const viewer of room.viewers.values()) {
    if (viewer.socket !== except) send(viewer.socket, message);
  }
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) { response.writeHead(404); response.end('Not found'); return; }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
    response.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    response.end(content);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (socket) => {
  let participant = null;

  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.type === 'create-room') {
      const code = roomCode();
      const room = { host: socket, viewers: new Map() };
      rooms.set(code, room);
      participant = { role: 'host', roomCode: code };
      send(socket, { type: 'room-created', roomCode: code });
      return;
    }

    if (message.type === 'join-room') {
      const code = String(message.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || !room.host) { send(socket, { type: 'error', message: 'That room is not live right now.' }); return; }
      const viewerId = crypto.randomUUID();
      const viewer = { id: viewerId, name: String(message.name || 'Guest').slice(0, 32), socket, approved: false };
      room.viewers.set(viewerId, viewer);
      participant = { role: 'viewer', roomCode: code, viewerId };
      send(socket, { type: 'waiting', roomCode: code });
      send(room.host, { type: 'join-request', viewerId, name: viewer.name });
      return;
    }

    if (!participant) return;
    const room = rooms.get(participant.roomCode);
    if (!room) return;

    if (participant.role === 'host' && message.type === 'approve-viewer') {
      const viewer = room.viewers.get(message.viewerId);
      if (!viewer) return;
      viewer.approved = true;
      send(viewer.socket, { type: 'approved', viewerId: viewer.id });
      broadcast(room, { type: 'viewer-count', count: [...room.viewers.values()].filter((item) => item.approved).length });
      return;
    }

    if (participant.role === 'host' && message.type === 'reject-viewer') {
      const viewer = room.viewers.get(message.viewerId);
      if (!viewer) return;
      send(viewer.socket, { type: 'rejected' });
      room.viewers.delete(message.viewerId);
      return;
    }

    if (message.type === 'signal') {
      if (participant.role === 'host') {
        const viewer = room.viewers.get(message.viewerId);
        if (viewer && viewer.approved) send(viewer.socket, { type: 'signal', signal: message.signal });
      } else if (room.host) {
        send(room.host, { type: 'signal', viewerId: participant.viewerId, signal: message.signal });
      }
    }
  });

  socket.on('close', () => {
    if (!participant) return;
    const room = rooms.get(participant.roomCode);
    if (!room) return;
    if (participant.role === 'host') {
      for (const viewer of room.viewers.values()) send(viewer.socket, { type: 'room-ended' });
      rooms.delete(participant.roomCode);
    } else {
      room.viewers.delete(participant.viewerId);
      send(room.host, { type: 'viewer-left', viewerId: participant.viewerId });
    }
  });
});

server.listen(PORT, () => console.log(`Open Room Live is running at http://localhost:${PORT}`));
