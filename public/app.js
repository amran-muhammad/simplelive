const state = { socket: null, role: null, roomCode: null, stream: null, screenStream: null, peers: new Map(), pendingCandidates: new Map(), policy: { mic: true, camera: true }, media: { mic: false, camera: false } };
const $ = (selector) => document.querySelector(selector);
const landing = $('#landing'); const studio = $('#studio'); const viewer = $('#viewer');

function show(view) { [landing, studio, viewer].forEach((item) => item.classList.add('hidden')); view.classList.remove('hidden'); }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); setTimeout(() => element.classList.remove('show'), 3200); }
function connect() { state.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); state.socket.addEventListener('message', (event) => handleMessage(JSON.parse(event.data))); state.socket.addEventListener('close', () => { if (state.role === 'viewer') toast('The connection closed.'); }); }
function send(message) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); }
function roomUrl(code) { return `${location.origin}${location.pathname}?room=${code}`; }

$('#start-live').addEventListener('click', async () => {
  state.role = 'host'; connect();
  state.socket.addEventListener('open', () => send({ type: 'create-room' }), { once: true });
});

$('#join-form').addEventListener('submit', (event) => { event.preventDefault(); state.role = 'viewer'; state.roomCode = $('#room-code').value.trim().toUpperCase(); const name = $('#guest-name').value.trim(); if (!state.roomCode || !name) return; $('#viewer-room-label').textContent = `ROOM ${state.roomCode}`; show(viewer); connect(); state.socket.addEventListener('open', () => send({ type: 'join-room', roomCode: state.roomCode, name }), { once: true }); });

$('#copy-link').addEventListener('click', async () => { await navigator.clipboard.writeText($('#share-link-text').dataset.url); toast('Invite link copied.'); });
$('#end-live').addEventListener('click', () => { stopAllMedia(); state.socket?.close(); location.href = location.pathname; });

async function requestMedia(kind) {
  if (kind === 'camera' && !state.policy.camera) return toast('The host has disabled guest cameras.');
  if (kind === 'mic' && !state.policy.mic) return toast('The host has disabled guest microphones.');
  try {
    const wanted = { video: kind === 'camera' && !state.media.camera, audio: kind === 'mic' && !state.media.mic };
    const media = await navigator.mediaDevices.getUserMedia(wanted);
    if (!state.stream) state.stream = new MediaStream();
    media.getTracks().forEach((track) => { state.stream.addTrack(track); state.media[track.kind === 'video' ? 'camera' : 'mic'] = true; addTrackToPeers(track); });
    updateMediaButtons();
    if (state.role === 'viewer') send({ type: 'renegotiate' }); else state.peers.forEach((peer, viewerId) => renegotiatePeer(viewerId, peer));
  } catch (error) { toast(error.name === 'NotAllowedError' ? 'Allow device access in your browser to turn this on.' : 'This device could not provide that media.'); }
}
function addTrackToPeers(track) { state.peers.forEach((peer) => peer.addTrack(track, state.stream)); }
function setMedia(kind, enabled) { state.stream?.getTracks().filter((track) => track.kind === kind).forEach((track) => { track.enabled = enabled; }); state.media[kind === 'video' ? 'camera' : 'mic'] = enabled; updateMediaButtons(); }
function updateMediaButtons() { const mic = state.role === 'host' ? $('#host-mic') : $('#viewer-mic'); const camera = state.role === 'host' ? $('#host-camera') : $('#viewer-camera'); if (mic) mic.textContent = `Mic ${state.media.mic ? 'on' : 'off'}`; if (camera) camera.textContent = `Camera ${state.media.camera ? 'on' : 'off'}`; }
function stopAllMedia() { [...(state.stream?.getTracks() || []), ...(state.screenStream?.getTracks() || [])].forEach((track) => track.stop()); }
async function shareScreen() { try { state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true }); const screenTrack = state.screenStream.getVideoTracks()[0]; state.peers.forEach((peer) => { const sender = peer.getSenders().find((item) => item.track?.kind === 'video'); if (sender) sender.replaceTrack(screenTrack); else peer.addTrack(screenTrack, state.screenStream); }); const local = state.role === 'host' ? $('#local-video') : $('#viewer-local-video'); local.srcObject = state.screenStream; if (state.role === 'host') state.peers.forEach((peer, viewerId) => renegotiatePeer(viewerId, peer)); else send({ type: 'renegotiate' }); screenTrack.onended = () => { const camera = state.stream?.getVideoTracks()[0]; state.peers.forEach((peer) => peer.getSenders().find((item) => item.track?.kind === 'video')?.replaceTrack(camera || null)); local.srcObject = state.stream || null; }; } catch { toast('Screen sharing was cancelled or is unavailable.'); } }
function submitChat(input) { const message = input.value.trim(); if (!message) return; send({ type: 'chat', text: message }); input.value = ''; }
function addChatMessage(target, name, text) { const item = document.createElement('p'); item.innerHTML = `<strong>${escapeHtml(name)}</strong> ${escapeHtml(text)}`; target.appendChild(item); target.scrollTop = target.scrollHeight; }

$('#host-mic').onclick = () => state.media.mic ? setMedia('audio', false) : requestMedia('mic');
$('#host-camera').onclick = () => state.media.camera ? setMedia('video', false) : requestMedia('camera');
$('#host-share').onclick = shareScreen; $('#viewer-mic').onclick = () => state.media.mic ? setMedia('audio', false) : requestMedia('mic'); $('#viewer-camera').onclick = () => state.media.camera ? setMedia('video', false) : requestMedia('camera'); $('#viewer-share').onclick = shareScreen;
$('#host-chat-form').onsubmit = (event) => { event.preventDefault(); submitChat($('#host-chat-input')); }; $('#viewer-chat-form').onsubmit = (event) => { event.preventDefault(); submitChat($('#viewer-chat-input')); };
$('#allow-guest-mic').onchange = () => send({ type: 'media-policy', policy: { mic: $('#allow-guest-mic').checked, camera: $('#allow-guest-camera').checked } }); $('#allow-guest-camera').onchange = () => send({ type: 'media-policy', policy: { mic: $('#allow-guest-mic').checked, camera: $('#allow-guest-camera').checked } });

async function makeHostPeer(viewerId) {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.peers.set(viewerId, peer); state.stream?.getTracks().forEach((track) => peer.addTrack(track, state.stream));
  peer.ontrack = (event) => addRemoteViewer(viewerId, event.streams[0]);
  peer.onicecandidate = (event) => event.candidate && send({ type: 'signal', viewerId, signal: { candidate: event.candidate } });
  peer.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(peer.connectionState)) toast('The viewer connection was interrupted.'); };
  await renegotiatePeer(viewerId, peer);
}

async function renegotiatePeer(viewerId, peer) { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); send({ type: 'signal', viewerId, signal: { description: peer.localDescription } }); }

function addRemoteViewer(viewerId, stream) {
  let tile = document.querySelector(`[data-viewer-id="${viewerId}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.viewerId = viewerId;
    tile.innerHTML = '<video autoplay playsinline></video><span>Guest</span>';
    $('#host-video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}

function addRequest(viewerId, name) { const list = $('#request-list'); const empty = list.querySelector('.empty-state'); if (empty) empty.remove(); const item = document.createElement('div'); item.className = 'request'; item.dataset.viewerId = viewerId; item.innerHTML = `<span>${escapeHtml(name)}</span><span class="request-actions"><button class="approve" title="Approve">✓</button><button class="reject" title="Decline">×</button></span>`; item.querySelector('.approve').onclick = () => { send({ type: 'approve-viewer', viewerId }); item.remove(); updateRequestCount(); makeHostPeer(viewerId); }; item.querySelector('.reject').onclick = () => { send({ type: 'reject-viewer', viewerId }); item.remove(); updateRequestCount(); }; list.appendChild(item); updateRequestCount(); }
function updateRequestCount() { $('#request-count').textContent = document.querySelectorAll('.request').length; }
function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

async function handleMessage(message) {
  if (message.type === 'room-created') { state.roomCode = message.roomCode; $('#studio-room-code').textContent = message.roomCode; $('#share-link-text').textContent = roomUrl(message.roomCode); $('#share-link-text').dataset.url = roomUrl(message.roomCode); show(studio); history.replaceState({}, '', `?room=${message.roomCode}`); }
  if (message.type === 'join-request') addRequest(message.viewerId, message.name);
  if (message.type === 'viewer-left') { document.querySelector(`[data-viewer-id="${message.viewerId}"]`)?.remove(); state.peers.get(message.viewerId)?.close(); state.peers.delete(message.viewerId); }
  if (message.type === 'viewer-count') $('#viewer-count').textContent = `${message.count} viewer${message.count === 1 ? '' : 's'}`;
  if (message.type === 'media-policy') { state.policy = message.policy; $('#viewer-mic').disabled = !state.policy.mic; $('#viewer-camera').disabled = !state.policy.camera; if (!state.policy.mic) setMedia('audio', false); if (!state.policy.camera) setMedia('video', false); }
  if (message.type === 'chat') { addChatMessage(state.role === 'host' ? $('#host-chat') : $('#viewer-chat'), message.name, message.text); }
  if (message.type === 'renegotiate' && state.role === 'host') { const peer = state.peers.get(message.viewerId); if (peer) await renegotiatePeer(message.viewerId, peer); }
  if (message.type === 'waiting') { show(viewer); $('#viewer-room-label').textContent = `ROOM ${message.roomCode}`; }
  if (message.type === 'approved') toast('You are in. Connecting to the room…');
  if (message.type === 'rejected') { toast('The host did not approve this request.'); setTimeout(() => location.href = location.pathname, 2200); }
  if (message.type === 'room-ended') { $('#viewer-waiting').innerHTML = '<span class="waiting-mark">×</span><p class="eyebrow">Room closed</p><h1>The live has ended.</h1><p>Thanks for stopping by.</p>'; }
  if (message.type === 'error') toast(message.message);
  if (message.type === 'signal') await handleSignal(message);
}

async function addPendingCandidates(peerKey, peer) {
  const candidates = state.pendingCandidates.get(peerKey) || [];
  for (const candidate of candidates) await peer.addIceCandidate(candidate);
  state.pendingCandidates.delete(peerKey);
}

async function handleSignal(message) {
  if (state.role === 'host') { const peer = state.peers.get(message.viewerId); if (!peer) return; if (message.signal.description) { await peer.setRemoteDescription(message.signal.description); await addPendingCandidates(message.viewerId, peer); } if (message.signal.candidate) { if (peer.remoteDescription) await peer.addIceCandidate(message.signal.candidate); else state.pendingCandidates.set(message.viewerId, [...(state.pendingCandidates.get(message.viewerId) || []), message.signal.candidate]); } return; }
  let peer = state.peers.get('host');
  if (!peer) { peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set('host', peer); peer.ontrack = (event) => { $('#remote-video').srcObject = event.streams[0]; $('#viewer-waiting').classList.add('hidden'); $('#viewer-stage').classList.remove('hidden'); }; peer.onicecandidate = (event) => event.candidate && send({ type: 'signal', signal: { candidate: event.candidate } }); peer.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(peer.connectionState)) toast('The live connection was interrupted.'); }; }
  if (message.signal.description) { await peer.setRemoteDescription(message.signal.description); await addPendingCandidates('host', peer); if (message.signal.description.type === 'offer') { const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); send({ type: 'signal', signal: { description: peer.localDescription } }); } } if (message.signal.candidate) { if (peer.remoteDescription) await peer.addIceCandidate(message.signal.candidate); else state.pendingCandidates.set('host', [...(state.pendingCandidates.get('host') || []), message.signal.candidate]); }
}

const queryRoom = new URLSearchParams(location.search).get('room');
if (queryRoom) {
  $('#room-code').value = queryRoom.toUpperCase();
  $('#room-code').required = false;
  $('#room-code-field').classList.add('hidden');
  $('#join-title').textContent = 'You are invited in';
  $('#join-description').textContent = 'Tell the host who is at the door. They will approve you before the live appears.';
  $('#guest-name').focus();
}
