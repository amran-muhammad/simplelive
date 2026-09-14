const state = { socket: null, role: null, roomCode: null, viewerId: null, name: '', stream: null, screenStream: null, screenShareOwner: null, screenSharePending: false, screenSharing: false, peers: new Map(), pendingCandidates: new Map(), viewerNames: new Map(), policy: { mic: true, camera: true }, media: { mic: false, camera: false } };
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

$('#join-form').addEventListener('submit', (event) => { event.preventDefault(); state.role = 'viewer'; state.roomCode = $('#room-code').value.trim().toUpperCase(); state.name = $('#guest-name').value.trim(); if (!state.roomCode || !state.name) return; $('#viewer-name-tile').textContent = state.name; $('#viewer-room-label').textContent = `ROOM ${state.roomCode}`; show(viewer); connect(); state.socket.addEventListener('open', () => send({ type: 'join-room', roomCode: state.roomCode, name: state.name }), { once: true }); });

$('#copy-link').addEventListener('click', async () => { await navigator.clipboard.writeText($('#share-link-text').dataset.url); toast('Invite link copied.'); });
$('#end-live').addEventListener('click', () => { stopAllMedia(); state.socket?.close(); location.href = location.pathname; });
$('#leave-meeting').addEventListener('click', () => { stopAllMedia(); state.socket?.send(JSON.stringify({ type: 'leave-room' })); state.socket?.close(); location.href = location.pathname; });

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
function updateMediaButtons() {
  const mic = state.role === 'host' ? $('#host-mic') : $('#viewer-mic');
  const camera = state.role === 'host' ? $('#host-camera') : $('#viewer-camera');
  if (mic) {
    mic.textContent = `Mic ${state.media.mic ? 'on' : 'off'}`;
    mic.setAttribute('aria-pressed', String(state.media.mic));
    mic.classList.toggle('is-active', state.media.mic);
  }
  if (camera) {
    camera.textContent = `Camera ${state.media.camera ? 'on' : 'off'}`;
    camera.setAttribute('aria-pressed', String(state.media.camera));
    camera.classList.toggle('is-active', state.media.camera);
  }
}
function stopAllMedia() { stopScreenShare(false); [...(state.stream?.getTracks() || [])].forEach((track) => track.stop()); }
function localScreenOwner(owner) { return owner && ((state.role === 'host' && owner.role === 'host') || (state.role === 'viewer' && owner.role === 'viewer' && owner.viewerId === state.viewerId)); }
function applyScreenShare(owner) {
  const stage = state.role === 'host' ? $('#host-stage') : $('#viewer-stage');
  const view = state.role === 'host' ? $('#host-screen-share') : $('#viewer-screen-share');
  const video = state.role === 'host' ? $('#host-screen-video') : $('#viewer-screen-video');
  const button = state.role === 'host' ? $('#host-share') : $('#viewer-share');
  const fullscreen = state.role === 'host' ? $('#host-screen-fullscreen') : $('#viewer-screen-fullscreen');
  const active = Boolean(owner);
  stage.classList.toggle('is-screen-sharing', active);
  view.classList.toggle('hidden', !active);
  button.disabled = active && !localScreenOwner(owner);
  button.textContent = localScreenOwner(owner) ? 'Stop sharing' : 'Share screen';
  if (fullscreen) fullscreen.disabled = !active;
  if (localScreenOwner(owner) && state.screenStream) video.srcObject = state.screenStream;
}
function stopScreenShare(notify = true) {
  if (!state.screenStream && !state.screenSharing) return;
  [...(state.screenStream?.getTracks() || [])].forEach((track) => track.stop());
  const camera = state.stream?.getVideoTracks()[0] || null;
  const microphone = state.stream?.getAudioTracks()[0] || null;
  state.peers.forEach((peer) => {
    peer.getSenders().find((item) => item.track?.kind === 'video')?.replaceTrack(camera);
    peer.getSenders().find((item) => item.track?.kind === 'audio')?.replaceTrack(microphone);
  });
  if (state.role === 'host') $('#local-video').srcObject = state.stream || null; else $('#viewer-local-video').srcObject = state.stream || null;
  state.screenStream = null; state.screenSharing = false; state.screenSharePending = false; state.screenShareOwner = null; applyScreenShare(null);
  if (notify) send({ type: 'screen-share-stop' });
}
async function startScreenCapture() { try { state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); state.screenSharing = true; applyScreenShare(state.screenShareOwner); const screenTrack = state.screenStream.getVideoTracks()[0]; const audioTrack = state.screenStream.getAudioTracks()[0]; state.peers.forEach((peer) => { const videoSender = peer.getSenders().find((item) => item.track?.kind === 'video'); if (videoSender) videoSender.replaceTrack(screenTrack); else peer.addTrack(screenTrack, state.screenStream); if (audioTrack) { const audioSender = peer.getSenders().find((item) => item.track?.kind === 'audio'); if (audioSender) audioSender.replaceTrack(audioTrack); else peer.addTrack(audioTrack, state.screenStream); } }); if (!audioTrack) toast('Screen is sharing without audio. Choose a tab or window with audio enabled.'); if (state.role === 'host') state.peers.forEach((peer, viewerId) => renegotiatePeer(viewerId, peer)); else send({ type: 'renegotiate' }); screenTrack.onended = () => stopScreenShare(); } catch { state.screenSharePending = false; send({ type: 'screen-share-stop' }); toast('Screen sharing was cancelled or is unavailable.'); } }
function shareScreen() { if (state.screenSharing) return stopScreenShare(); if (state.screenSharePending) return; state.screenSharePending = true; send({ type: 'screen-share-request' }); }
function submitChat(input) { const message = input.value.trim(); if (!message) return; send({ type: 'chat', kind: 'text', text: message }); input.value = ''; }
function addChatMessage(target, message) {
  const item = document.createElement('div'); item.className = 'chat-message';
  const header = `<strong>${escapeHtml(message.name)}</strong>`;
  const body = message.kind === 'gif' && /^https?:\/\//i.test(message.text) ? `<img class="chat-gif" src="${escapeHtml(message.text)}" alt="GIF shared by ${escapeHtml(message.name)}" loading="lazy">` : message.kind === 'reaction' ? `<span class="chat-reaction">${escapeHtml(message.text)}</span>` : `<span>${escapeHtml(message.text)}</span>`;
  item.innerHTML = `<div class="chat-bubble"><div>${header}</div>${body}</div><div class="reaction-row"><button type="button" data-reaction="❤️">❤️</button><button type="button" data-reaction="😂">😂</button><button type="button" data-reaction="👏">👏</button><button type="button" data-reaction="🔥">🔥</button></div>`;
  item.querySelectorAll('[data-reaction]').forEach((button) => { button.onclick = () => send({ type: 'chat', kind: 'reaction', text: `${button.dataset.reaction} ${message.name}` }); });
  target.appendChild(item); target.scrollTop = target.scrollHeight;
}
function addEmoji(formId, emoji) { const input = document.querySelector(`#${formId} input`); input.value += emoji; input.focus(); }
function openGifPrompt(input) { const url = window.prompt('Paste a GIF URL'); if (url && /^https?:\/\//i.test(url.trim())) { send({ type: 'chat', kind: 'gif', text: url.trim() }); input.focus(); } else if (url) toast('Please use a valid GIF URL.'); }

$('#host-mic').onclick = () => state.media.mic ? setMedia('audio', false) : requestMedia('mic');
$('#host-camera').onclick = () => state.media.camera ? setMedia('video', false) : requestMedia('camera');
$('#host-share').onclick = shareScreen; $('#viewer-mic').onclick = () => state.media.mic ? setMedia('audio', false) : requestMedia('mic'); $('#viewer-camera').onclick = () => state.media.camera ? setMedia('video', false) : requestMedia('camera'); $('#viewer-share').onclick = shareScreen;
async function toggleFullscreen(target, button) { if (!document.fullscreenElement) { if (!target?.requestFullscreen) return toast('Full screen is not supported in this browser.'); try { await target.requestFullscreen(); button.textContent = 'Exit full screen'; } catch { toast('Full screen permission was denied.'); } } else { await document.exitFullscreen(); button.textContent = 'Full screen'; } }
$('#app-fullscreen').onclick = () => toggleFullscreen(document.documentElement, $('#app-fullscreen'));
$('#host-fullscreen').onclick = () => toggleFullscreen($('#host-stage'), $('#host-fullscreen')); $('#viewer-fullscreen').onclick = () => toggleFullscreen($('#viewer-stage'), $('#viewer-fullscreen'));
$('#host-screen-fullscreen').onclick = () => toggleFullscreen($('#host-screen-video'), $('#host-screen-fullscreen')); $('#viewer-screen-fullscreen').onclick = () => toggleFullscreen($('#viewer-screen-video'), $('#viewer-screen-fullscreen'));
document.addEventListener('fullscreenchange', () => { const active = Boolean(document.fullscreenElement); [$('#app-fullscreen'), $('#host-fullscreen'), $('#viewer-fullscreen')].forEach((button) => { if (button) button.textContent = active ? 'Exit full screen' : 'Full screen'; }); });
$('#host-chat-form').onsubmit = (event) => { event.preventDefault(); submitChat($('#host-chat-input')); }; $('#viewer-chat-form').onsubmit = (event) => { event.preventDefault(); submitChat($('#viewer-chat-input')); };
document.querySelectorAll('[data-chat-action="emoji"]').forEach((button) => button.onclick = () => { const picker = document.querySelector(`[data-picker="${button.closest('form').id}"]`); picker.classList.toggle('hidden'); });
document.querySelectorAll('.emoji-picker').forEach((picker) => { const emojis = picker.textContent.trim().split(/\s+/); picker.innerHTML = emojis.map((emoji) => `<button type="button">${emoji}</button>`).join(''); picker.querySelectorAll('button').forEach((button) => button.onclick = () => addEmoji(picker.dataset.picker, button.textContent.trim())); });
document.querySelectorAll('[data-chat-action="gif"]').forEach((button) => button.onclick = () => openGifPrompt(button.closest('form').querySelector('input')));
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
    $('#host-video-empty').classList.add('hidden');
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.dataset.viewerId = viewerId;
    tile.innerHTML = `<video autoplay playsinline></video><span>${escapeHtml(state.viewerNames.get(viewerId) || 'Guest')}</span>`;
    $('#host-video-grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  if (state.screenShareOwner?.role === 'viewer' && state.screenShareOwner.viewerId === viewerId) $('#host-screen-video').srcObject = stream;
}

function addRequest(viewerId, name) { state.viewerNames.set(viewerId, name); const list = $('#request-list'); const empty = list.querySelector('.empty-state'); if (empty) empty.remove(); const item = document.createElement('div'); item.className = 'request'; item.dataset.viewerId = viewerId; item.innerHTML = `<span>${escapeHtml(name)}</span><span class="request-actions"><button class="approve" title="Approve">✓</button><button class="reject" title="Decline">×</button></span>`; item.querySelector('.approve').onclick = () => { send({ type: 'approve-viewer', viewerId }); item.remove(); updateRequestCount(); makeHostPeer(viewerId); }; item.querySelector('.reject').onclick = () => { send({ type: 'reject-viewer', viewerId }); item.remove(); updateRequestCount(); }; list.appendChild(item); updateRequestCount(); }
function updateRequestCount() { $('#request-count').textContent = document.querySelectorAll('.request').length; }
function escapeHtml(value) { return value.replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

async function handleMessage(message) {
  if (message.type === 'room-created') { state.roomCode = message.roomCode; $('#studio-room-code').textContent = message.roomCode; $('#share-link-text').textContent = roomUrl(message.roomCode); $('#share-link-text').dataset.url = roomUrl(message.roomCode); show(studio); history.replaceState({}, '', `?room=${message.roomCode}`); }
  if (message.type === 'join-request') addRequest(message.viewerId, message.name);
  if (message.type === 'viewer-left') { document.querySelector(`[data-viewer-id="${message.viewerId}"]`)?.remove(); state.peers.get(message.viewerId)?.close(); state.peers.delete(message.viewerId); state.viewerNames.delete(message.viewerId); }
  if (message.type === 'viewer-count') $('#viewer-count').textContent = `${message.count} viewer${message.count === 1 ? '' : 's'}`;
  if (message.type === 'media-policy') { state.policy = message.policy; $('#viewer-mic').disabled = !state.policy.mic; $('#viewer-camera').disabled = !state.policy.camera; if (!state.policy.mic) setMedia('audio', false); if (!state.policy.camera) setMedia('video', false); }
  if (message.type === 'chat') { addChatMessage(state.role === 'host' ? $('#host-chat') : $('#viewer-chat'), message); }
  if (message.type === 'renegotiate' && state.role === 'host') { const peer = state.peers.get(message.viewerId); if (peer) await renegotiatePeer(message.viewerId, peer); }
  if (message.type === 'waiting') { show(viewer); $('#viewer-room-label').textContent = `ROOM ${message.roomCode}`; }
  if (message.type === 'approved') { state.viewerId = message.viewerId; toast('You are in. Connecting to the room…'); }
  if (message.type === 'screen-share-approved') { state.screenSharePending = false; startScreenCapture(); }
  if (message.type === 'screen-share-denied') { state.screenSharePending = false; toast(message.message); }
  if (message.type === 'screen-share-start') { state.screenShareOwner = message.owner; applyScreenShare(message.owner); if (message.owner.role === 'host' && state.role === 'viewer') $('#viewer-screen-video').srcObject = $('#remote-video').srcObject; }
  if (message.type === 'screen-share-stop') { state.screenShareOwner = null; if (state.screenSharing) stopScreenShare(false); else applyScreenShare(null); }
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
  if (!peer) { peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); state.peers.set('host', peer); peer.ontrack = (event) => { $('#remote-video').srcObject = event.streams[0]; if (state.screenShareOwner?.role === 'host') $('#viewer-screen-video').srcObject = event.streams[0]; $('#viewer-waiting').classList.add('hidden'); $('#viewer-stage').classList.remove('hidden'); }; peer.onicecandidate = (event) => event.candidate && send({ type: 'signal', signal: { candidate: event.candidate } }); peer.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(peer.connectionState)) toast('The live connection was interrupted.'); }; }
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
