import React, { useState, useEffect, useRef } from 'react';
import { CryptoManager } from '../utils/Crypto';
import './TextChat.css';

const TextChat = ({ sessionId, ws, targetSessionId }) => {
  const [cryptoManager] = useState(new CryptoManager());
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [isReady, setIsReady] = useState(false);
  const messagesEndRef = useRef(null);
  const [selfDestructInput, setSelfDestructInput] = useState(false);
  const [roomDuration, setRoomDuration] = useState(300); // default 5 min
  const [roomCreated, setRoomCreated] = useState(false);
  const [roomCountdown, setRoomCountdown] = useState(null);

  useEffect(() => {
    if (!ws || !sessionId || !targetSessionId) return;
    
    // Send public key for key exchange
    ws.send(JSON.stringify({
      type: 'key_exchange',
      clientPublicKey: cryptoManager.getPublicKey(),
      sessionId: sessionId,
      targetSessionId: targetSessionId
    }));
  }, [ws, sessionId, targetSessionId, cryptoManager]);

  useEffect(() => {
    if (!ws) return;
    
    const handleMessage = async (e) => {
      const message = JSON.parse(e.data);
      
      if (message.targetSessionId && message.targetSessionId !== sessionId) return;
      
      try {
        switch (message.type) {
          case 'peer_key':
            cryptoManager.deriveSharedSecret(message.peerPublicKey);
            setIsReady(true);
            break;
            
          case 'text_message':
            const decryptedText = cryptoManager.decryptMessage(message.content);
            const isSelfDestruct = message.selfDestruct === true;
            const msgObj = {
              sender: message.sourceSessionId,
              content: decryptedText,
              timestamp: new Date().toLocaleTimeString(),
              selfDestruct: isSelfDestruct
            };
            setMessages(prev => {
              const newMsgs = [...prev, msgObj];
              if (isSelfDestruct) {
                setTimeout(() => {
                  setMessages(msgs => msgs.filter((m, i) => i !== newMsgs.length - 1));
                }, 10000);
              }
              return newMsgs;
            });
            break;
        }
      } catch (err) {
        console.error('Message handling error:', err);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, sessionId, cryptoManager]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !isReady) return;

    const encryptedMessage = cryptoManager.encryptMessage(newMessage);
    ws.send(JSON.stringify({
      type: 'text_message',
      content: encryptedMessage,
      sessionId,
      targetSessionId,
      selfDestruct: selfDestructInput
    }));

    const msgObj = {
      sender: 'me',
      content: newMessage,
      timestamp: new Date().toLocaleTimeString(),
      selfDestruct: selfDestructInput
    };
    setMessages(prev => {
      const newMsgs = [...prev, msgObj];
      if (selfDestructInput) {
        setTimeout(() => {
          setMessages(msgs => msgs.filter((m, i) => i !== newMsgs.length - 1));
        }, 10000);
      }
      return newMsgs;
    });
    setNewMessage('');
    setSelfDestructInput(false);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Add createRoom function for host
  const createRoom = () => {
    ws.send(JSON.stringify({ type: 'create_room', duration: roomDuration }));
  };

  // Listen for room_created and ephemeral_timeout
  useEffect(() => {
    if (!ws) return;
    const handleRoomEvents = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'room_created' && message.duration) {
          setRoomCreated(true);
          setRoomCountdown(message.duration);
        }
        if (message.type === 'ephemeral_timeout') {
          alert(message.message || 'Session expired.');
          setRoomCreated(false);
          setRoomCountdown(null);
        }
      } catch {}
    };
    ws.addEventListener('message', handleRoomEvents);
    return () => ws.removeEventListener('message', handleRoomEvents);
  }, [ws]);

  // Countdown timer effect
  useEffect(() => {
    if (!roomCountdown || !roomCreated) return;
    if (roomCountdown <= 0) return;
    const timer = setInterval(() => {
      setRoomCountdown(c => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [roomCountdown, roomCreated]);

  return (
    <div className="text-chat-container">
      {!roomCreated && (
        <div style={{margin:'1em 0'}}>
          <label>Session Duration (seconds): </label>
          <input type="number" min="60" max="3600" value={roomDuration} onChange={e => setRoomDuration(Number(e.target.value))} style={{width:'6em',marginRight:'1em'}} />
          <button onClick={createRoom}>Create Room</button>
        </div>
      )}
      {roomCreated && roomCountdown !== null && (
        <div style={{margin:'1em 0',color:'#e67e22',fontWeight:'bold'}}>Session ends in: {roomCountdown}s</div>
      )}
      {roomCreated && (
        <>
          <div className="chat-header">
            <h2>Text Chat</h2>
            <div className="security-status">
              {isReady ? '🔒 Secure' : '⚠️ Connecting...'}
            </div>
          </div>
          <div className="messages-container">
            {messages.map((msg, index) => (
              <div 
                key={index} 
                className={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}
              >
                <div className="message-content">{msg.content}</div>
                <div className="message-timestamp">{msg.timestamp}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
          <form onSubmit={sendMessage} className="message-input-container">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Type a message..."
              disabled={!isReady}
              className="message-input"
            />
            <button 
              type="button"
              onClick={() => setSelfDestructInput(v => !v)}
              style={{background:selfDestructInput?'#e74c3c':'#e9ecef',color:selfDestructInput?'#fff':'#333',marginRight:'0.5em'}}
              className="send-button"
            >
              {selfDestructInput ? '💣' : '💬'}
            </button>
            <button 
              type="submit" 
              disabled={!isReady || !newMessage.trim()}
              className="send-button"
            >
              Send
            </button>
          </form>
        </>
      )}
    </div>
  );
};

export default TextChat; 