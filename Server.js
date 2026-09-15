// Mingus Chatroom signaling server.
// This does ONE job: help two browsers find each other. No audio, no video,
// no chat ever touches it — that all stays peer-to-peer. It is tiny and free
// to run, and it replaces the flaky public PeerJS cloud.

const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const PORT = process.env.PORT || 9000;

// Neocities pages are a different origin, so they need CORS to reach us.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (req, res) => res.send('mingus signaling server: up'));
app.get('/health', (req, res) => res.json({ ok: true, up: process.uptime() }));

const server = app.listen(PORT, '0.0.0.0', () =>
  console.log('signaling server listening on ' + PORT)
);

const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: true,       // lets the chatroom list who is in a room
  alive_timeout: 30000,        // drop dead sockets fast so slots free up
  expire_timeout: 10000,
  concurrent_limit: 500,
});

peerServer.on('connection', (c) => console.log('+ ' + c.getId()));
peerServer.on('disconnect', (c) => console.log('- ' + c.getId()));

app.use('/', peerServer);
