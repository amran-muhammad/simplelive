# Open Room Live

A host-approved live video room using vanilla HTML, CSS, JavaScript, Node.js, WebSocket signaling, and WebRTC.

## Run it

1. Install Node.js 18 or newer.
2. In this folder run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000`.

Use two browser tabs to test locally. Start a room in one tab, then open the copied invite link in the other. The host can approve or decline each request.

## Share with real people

Camera and microphone access require a secure context. `localhost` is allowed for local testing, but a public deployment needs HTTPS. Deploy this Node app to a host that supports long-lived WebSocket connections, then share the HTTPS room link. For larger audiences or restrictive networks, configure a TURN server in `public/app.js` alongside the included public STUN server.
