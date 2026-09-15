const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const RECONNECT_GRACE = 30000;

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
      const room = { host: socket, hostToken: crypto.randomUUID(), viewers: new Map(), policy: { mic: true, camera: true }, screenSharer: null, cleanupTimer: null };
      rooms.set(code, room);
      participant = { role: 'host', roomCode: code };
      send(socket, { type: 'room-created', roomCode: code, sessionToken: room.hostToken });
      return;
    }

    if (message.type === 'join-room') {
      const code = String(message.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || !room.host) { send(socket, { type: 'error', message: 'That room is not live right now.' }); return; }
      const viewerId = crypto.randomUUID();
      const viewer = { id: viewerId, token: crypto.randomUUID(), name: String(message.name || 'Guest').slice(0, 32), socket, approved: false, cleanupTimer: null };
      room.viewers.set(viewerId, viewer);
      participant = { role: 'viewer', roomCode: code, viewerId };
      send(socket, { type: 'waiting', roomCode: code, sessionToken: viewer.token });
      send(room.host, { type: 'join-request', viewerId, name: viewer.name });
      return;
    }

    if (message.type === 'resume-room') {
      const code = String(message.roomCode || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(socket, { type: 'error', message: 'That room is no longer available.' }); return; }
      if (message.role === 'host' && message.sessionToken === room.hostToken) {
        clearTimeout(room.cleanupTimer); room.cleanupTimer = null; room.host = socket;
        participant = { role: 'host', roomCode: code };
        send(socket, { type: 'room-resumed', role: 'host', roomCode: code, policy: room.policy, viewers: [...room.viewers.values()].filter((viewer) => viewer.approved).map((viewer) => ({ viewerId: viewer.id, name: viewer.name })), pendingViewers: [...room.viewers.values()].filter((viewer) => !viewer.approved).map((viewer) => ({ viewerId: viewer.id, name: viewer.name })) });
        return;
      }
      const viewer = [...room.viewers.values()].find((item) => item.token === message.sessionToken);
      if (message.role === 'viewer' && viewer) {
        clearTimeout(viewer.cleanupTimer); viewer.cleanupTimer = null; viewer.socket = socket;
        participant = { role: 'viewer', roomCode: code, viewerId: viewer.id };
        send(socket, { type: 'room-resumed', role: 'viewer', roomCode: code, viewerId: viewer.id, approved: viewer.approved, name: viewer.name, policy: room.policy });
        return;
      }
      send(socket, { type: 'error', message: 'That session can no longer be resumed.' });
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
      send(viewer.socket, { type: 'media-policy', policy: room.policy });
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

    if (participant.role === 'host' && message.type === 'end-room') {
      for (const viewer of room.viewers.values()) send(viewer.socket, { type: 'room-ended' });
      rooms.delete(participant.roomCode); participant = null; socket.close();
      return;
    }

    if (participant.role === 'host' && message.type === 'media-policy') {
      room.policy = { mic: Boolean(message.policy?.mic), camera: Boolean(message.policy?.camera) };
      for (const viewer of room.viewers.values()) send(viewer.socket, { type: 'media-policy', policy: room.policy });
      return;
    }

    if (message.type === 'screen-share-request') {
      const owner = participant.role === 'host' ? { role: 'host' } : { role: 'viewer', viewerId: participant.viewerId };
      const ownerKey = owner.role === 'host' ? 'host' : owner.viewerId;
      if (room.screenSharer && room.screenSharer !== ownerKey) {
        send(socket, { type: 'screen-share-denied', message: 'Someone else is already sharing their screen.' });
        return;
      }
      room.screenSharer = ownerKey;
      send(socket, { type: 'screen-share-approved' });
      broadcast(room, { type: 'screen-share-start', owner });
      return;
    }

    if (message.type === 'screen-share-stop') {
      const ownerKey = participant.role === 'host' ? 'host' : participant.viewerId;
      if (room.screenSharer !== ownerKey) return;
      room.screenSharer = null;
      broadcast(room, { type: 'screen-share-stop' });
      return;
    }

    if (message.type === 'chat') {
      const name = participant.role === 'host' ? 'Host' : room.viewers.get(participant.viewerId)?.name || 'Guest';
      const kind = ['text', 'gif', 'reaction'].includes(message.kind) ? message.kind : 'text';
      broadcast(room, { type: 'chat', kind, name, text: String(message.text || '').slice(0, 500) });
      return;
    }

    if (participant.role === 'viewer' && message.type === 'renegotiate') {
      send(room.host, { type: 'renegotiate', viewerId: participant.viewerId });
      return;
    }

    if (participant.role === 'viewer' && message.type === 'leave-room') {
      room.viewers.delete(participant.viewerId);
      send(room.host, { type: 'viewer-left', viewerId: participant.viewerId });
      send(room.host, { type: 'viewer-count', count: [...room.viewers.values()].filter((item) => item.approved).length });
      participant = null;
      socket.close();
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
      if (room.host !== socket) return;
      room.host = null;
      room.cleanupTimer = setTimeout(() => {
        for (const viewer of room.viewers.values()) send(viewer.socket, { type: 'room-ended' });
        rooms.delete(participant.roomCode);
      }, RECONNECT_GRACE);
    } else {
      const viewer = room.viewers.get(participant.viewerId);
      if (!viewer || viewer.socket !== socket) return;
      viewer.socket = null;
      viewer.cleanupTimer = setTimeout(() => {
        if (room.screenSharer === participant.viewerId) broadcast(room, { type: 'screen-share-stop' });
        room.viewers.delete(participant.viewerId);
        send(room.host, { type: 'viewer-left', viewerId: participant.viewerId });
      }, RECONNECT_GRACE);
    }
  });
});

server.listen(PORT, () => console.log(`Open Room Live is running at http://localhost:${PORT}`));
