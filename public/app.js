const state = { socket: null, role: null, roomCode: null, stream: null, peers: new Map() };
const $ = (selector) => document.querySelector(selector);
const landing = $('#landing'); const studio = $('#studio'); const viewer = $('#viewer');

function show(view) { [landing, studio, viewer].forEach((item) => item.classList.add('hidden')); view.classList.remove('hidden'); }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); setTimeout(() => element.classList.remove('show'), 3200); }
function connect() { state.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); state.socket.addEventListener('message', (event) => handleMessage(JSON.parse(event.data))); state.socket.addEventListener('close', () => { if (state.role === 'viewer') toast('The connection closed.'); }); }
function send(message) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); }
function roomUrl(code) { return `${location.origin}${location.pathname}?room=${code}`; }

$('#start-live').addEventListener('click', async () => {
  state.role = 'host'; connect();
  try { state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); $('#local-video').srcObject = state.stream; $('#host-video-empty').classList.add('hidden'); } catch { toast('Camera access is needed to start a live room.'); return; }
  state.socket.addEventListener('open', () => send({ type: 'create-room' }), { once: true });
});

$('#join-form').addEventListener('submit', (event) => { event.preventDefault(); state.role = 'viewer'; state.roomCode = $('#room-code').value.trim().toUpperCase(); const name = $('#guest-name').value.trim(); if (!state.roomCode || !name) return; $('#viewer-room-label').textContent = `ROOM ${state.roomCode}`; show(viewer); connect(); state.socket.addEventListener('open', () => send({ type: 'join-room', roomCode: state.roomCode, name }), { once: true }); });

$('#copy-link').addEventListener('click', async () => { await navigator.clipboard.writeText($('#share-link-text').dataset.url); toast('Invite link copied.'); });
$('#end-live').addEventListener('click', () => { state.stream?.getTracks().forEach((track) => track.stop()); state.socket?.close(); location.href = location.pathname; });

async function makeHostPeer(viewerId) {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.peers.set(viewerId, peer); state.stream.getTracks().forEach((track) => peer.addTrack(track, state.stream));
  peer.onicecandidate = (event) => event.candidate && send({ type: 'signal', viewerId, signal: { candidate: event.candidate } });
  const offer = await peer.createOffer(); await peer.setLocalDescription(offer); send({ type: 'signal', viewerId, signal: { description: peer.localDescription } });
}

function addRequest(viewerId, name) { const list = $('#request-list'); const empty = list.querySelector('.empty-state'); if (empty) empty.remove(); const item = document.createElement('div'); item.className = 'request'; item.dataset.viewerId = viewerId; item.innerHTML = `<span>${escapeHtml(name)}</span><span class="request-actions"><button class="approve" title="Approve">✓</button><button class="reject" title="Decline">×</button></span>`; item.querySelector('.approve').onclick = () => { send({ type: 'approve-viewer', viewerId }); item.remove(); updateRequestCount(); makeHostPeer(viewerId); }; item.querySelector('.reject').onclick = () => { send({ type: 'reject-viewer', viewerId }); item.remove(); updateRequestCount(); }; list.appendChild(item); updateRequestCount(); }
function updateRequestCount() { $('#request-count').textContent = document.querySelectorAll('.request').length; }
function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

async function handleMessage(message) {
  if (message.type === 'room-created') { state.roomCode = message.roomCode; $('#studio-room-code').textContent = message.roomCode; $('#share-link-text').textContent = roomUrl(message.roomCode); $('#share-link-text').dataset.url = roomUrl(message.roomCode); show(studio); history.replaceState({}, '', `?room=${message.roomCode}`); }
  if (message.type === 'join-request') addRequest(message.viewerId, message.name);
  if (message.type === 'viewer-count') $('#viewer-count').textContent = `${message.count} viewer${message.count === 1 ? '' : 's'}`;
  if (message.type === 'waiting') { show(viewer); $('#viewer-room-label').textContent = `ROOM ${message.roomCode}`; }
  if (message.type === 'approved') toast('You are in. Connecting to the room…');
  if (message.type === 'rejected') { toast('The host did not approve this request.'); setTimeout(() => location.href = location.pathname, 2200); }
  if (message.type === 'room-ended') { $('#viewer-waiting').innerHTML = '<span class="waiting-mark">×</span><p class="eyebrow">Room closed</p><h1>The live has ended.</h1><p>Thanks for stopping by.</p>'; }
  if (message.type === 'error') toast(message.message);
  if (message.type === 'signal') await handleSignal(message);
}

async function handleSignal(message) {
  if (state.role === 'host') { const peer = state.peers.get(message.viewerId); if (!peer) return; if (message.signal.description) await peer.setRemoteDescription(message.signal.description); if (message.signal.candidate) await peer.addIceCandidate(message.signal.candidate); return; }
  let peer = state.peers.get('host');
  if (!peer) { peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set('host', peer); peer.ontrack = (event) => { $('#remote-video').srcObject = event.streams[0]; $('#viewer-waiting').classList.add('hidden'); $('#viewer-stage').classList.remove('hidden'); }; peer.onicecandidate = (event) => event.candidate && send({ type: 'signal', signal: { candidate: event.candidate } }); }
  if (message.signal.description) { await peer.setRemoteDescription(message.signal.description); if (message.signal.description.type === 'offer') { const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); send({ type: 'signal', signal: { description: peer.localDescription } }); } } if (message.signal.candidate) await peer.addIceCandidate(message.signal.candidate);
}

const queryRoom = new URLSearchParams(location.search).get('room'); if (queryRoom) $('#room-code').value = queryRoom.toUpperCase();
