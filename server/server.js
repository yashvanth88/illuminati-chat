const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Add process-level error logging at the top of the file
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// SSL Configuration
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'ssl', 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl', 'server.cert'))
};

const server = require('https').createServer(sslOptions, app);
const wss = new WebSocket.Server({ 
  server,
  // Allow connections from any origin
  verifyClient: (info, callback) => {
    callback(true);
  },
  // Add ping interval
  perMessageDeflate: false,
  clientTracking: true
});

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Store active sessions
const sessions = new Map();

// Keep track of session cleanup
const sessionTimeouts = new Map();

// Room management
const rooms = new Map(); // passcode -> { roomId, hostSessionId, joinerSessionId, duration, timeout }

function generatePasscode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let passcode = '';
  for (let i = 0; i < length; i++) {
    passcode += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return passcode;
}

function generateRoomId() {
  return crypto.randomBytes(8).toString('hex');
}

// Function to cleanup session
function cleanupSession(sessionId) {
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.close(1000, 'Session cleanup');
    }
    sessions.delete(sessionId);
    if (sessionTimeouts.has(sessionId)) {
      clearTimeout(sessionTimeouts.get(sessionId));
      sessionTimeouts.delete(sessionId);
    }
  }
}

// Function to relay message to target session
function relayMessage(senderSessionId, targetSessionId, message) {
  const targetSession = sessions.get(targetSessionId);
  if (!targetSession) {
    console.log(`Target session ${targetSessionId} not found, buffering message`);
    // Buffer the message for when the target connects
    if (!messageBuffers.has(targetSessionId)) {
      messageBuffers.set(targetSessionId, []);
    }
    messageBuffers.get(targetSessionId).push({
      senderId: senderSessionId,
      message: message
    });
    return;
  }

  if (targetSession.ws.readyState === WebSocket.OPEN) {
    // Pass selfDestruct and ephemeral flags if present
    const relayPayload = {
      ...message,
      senderId: senderSessionId
    };
    if (message.selfDestruct) relayPayload.selfDestruct = true;
    if (message.ephemeral) relayPayload.ephemeral = true;
    targetSession.ws.send(JSON.stringify(relayPayload));
  } else {
    console.log(`Target session ${targetSessionId} WebSocket not open, buffering message`);
    if (!messageBuffers.has(targetSessionId)) {
      messageBuffers.set(targetSessionId, []);
    }
    messageBuffers.get(targetSessionId).push({
      senderId: senderSessionId,
      message: message
    });
  }
}

// Store message buffers for offline sessions
const messageBuffers = new Map();

// Only handle WebSocket connections
app.get('/', (req, res) => {
  res.status(200).json({ message: 'WebRTC Signaling Server' });
});

// Improved WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  // Mask the IP by hashing it
  const maskedIp = crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 12);
  console.log('New WebSocket connection from', maskedIp);
  
  // Generate a unique session ID (internal only)
  const sessionId = crypto.randomBytes(16).toString('hex');
  
  // Store session data
  sessions.set(sessionId, {
    ws,
    publicKey: null,
    roomId: null,
    role: null, // 'host' or 'joiner'
    lastPing: Date.now()
  });

  // Set up ping interval for this connection
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  // WebSocket message handler
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('Server received message', message.type, message);

      switch (message.type) {
        case 'create_room': {
          // Host creates a room
          const { duration } = message; // duration in seconds
          const passcode = generatePasscode();
          const roomId = generateRoomId();
          rooms.set(passcode, { roomId, hostSessionId: sessionId, joinerSessionId: null, duration: duration || 300, timeout: null });
          const session = sessions.get(sessionId);
          session.roomId = roomId;
          session.role = 'host';
          ws.send(JSON.stringify({ type: 'room_created', passcode, duration: duration || 300 }));
          // Start ephemeral timer
          const room = rooms.get(passcode);
          if (room.timeout) clearTimeout(room.timeout);
          room.timeout = setTimeout(() => {
            // Disconnect host
            const hostSession = sessions.get(room.hostSessionId);
            if (hostSession && hostSession.ws.readyState === WebSocket.OPEN) {
              hostSession.ws.send(JSON.stringify({ type: 'ephemeral_timeout', message: 'Session expired. Host disconnected.' }));
              hostSession.ws.close(4000, 'Ephemeral session expired');
            }
            // Notify joiner if present
            if (room.joinerSessionId) {
              const joinerSession = sessions.get(room.joinerSessionId);
              if (joinerSession && joinerSession.ws.readyState === WebSocket.OPEN) {
                joinerSession.ws.send(JSON.stringify({ type: 'ephemeral_timeout', message: 'Session expired. Host disconnected.' }));
              }
            }
            // Clean up room
            rooms.delete(passcode);
          }, (duration || 300) * 1000);
          break;
        }
        case 'join_room': {
          // Joiner enters passcode to join room
          const { passcode } = message;
          const room = rooms.get(passcode);
          if (!room) {
            ws.send(JSON.stringify({ type: 'join_room_result', success: false, error: 'Invalid passcode' }));
            return;
          }
          if (room.joinerSessionId) {
            ws.send(JSON.stringify({ type: 'join_room_result', success: false, error: 'Room already has a joiner' }));
            return;
          }
          room.joinerSessionId = sessionId;
          const session = sessions.get(sessionId);
          session.roomId = room.roomId;
          session.role = 'joiner';
          ws.send(JSON.stringify({ type: 'join_room_result', success: true }));
          // Notify host that joiner has joined
          const hostSession = sessions.get(room.hostSessionId);
          if (hostSession && hostSession.ws.readyState === WebSocket.OPEN) {
            hostSession.ws.send(JSON.stringify({ type: 'joiner_joined' }));
          }
          // Make the code single-use: delete from rooms map
          rooms.delete(passcode);
          break;
        }
        case 'key_exchange': {
          // Only allow if both clients are in the same room
          const session = sessions.get(sessionId);
          if (!session.roomId) return;
          const room = Array.from(rooms.values()).find(r => r.roomId === session.roomId);
          if (!room || !room.hostSessionId || !room.joinerSessionId) return;
          session.publicKey = message.clientPublicKey;
          // Relay public key to the other party
          let peerSessionId = (session.role === 'host') ? room.joinerSessionId : room.hostSessionId;
          const peerSession = sessions.get(peerSessionId);
          if (peerSession && peerSession.publicKey) {
            session.ws.send(JSON.stringify({ type: 'peer_key', peerPublicKey: peerSession.publicKey }));
            peerSession.ws.send(JSON.stringify({ type: 'peer_key', peerPublicKey: session.publicKey }));
          }
          break;
        }
        case 'relay': {
          // Relay encrypted or signaling messages to the other party in the room
          const session = sessions.get(sessionId);
          if (!session.roomId) return;
          const room = Array.from(rooms.values()).find(r => r.roomId === session.roomId);
          if (!room || !room.hostSessionId || !room.joinerSessionId) return;
          let peerSessionId = (session.role === 'host') ? room.joinerSessionId : room.hostSessionId;
          relayMessage(sessionId, peerSessionId, message);
          break;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Error processing message' }));
    }
  });

  ws.on('pong', () => {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastPing = Date.now();
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for session ${sessionId}`);
    clearInterval(pingInterval);
    // Clean up session and room
    const session = sessions.get(sessionId);
    if (session && session.roomId) {
      const room = Array.from(rooms.values()).find(r => r.roomId === session.roomId);
      if (room) {
        if (room.hostSessionId === sessionId) room.hostSessionId = null;
        if (room.joinerSessionId === sessionId) room.joinerSessionId = null;
        if (!room.hostSessionId && !room.joinerSessionId) {
          // Remove room if empty
          const passcode = Array.from(rooms.entries()).find(([k, v]) => v.roomId === session.roomId)?.[0];
          if (passcode) rooms.delete(passcode);
        }
      }
    }
    sessions.delete(sessionId);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
    sessions.delete(sessionId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Secure server running on https://0.0.0.0:${PORT}`);
  console.log('Server is accessible from any IP address');
});