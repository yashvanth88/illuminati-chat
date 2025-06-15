// Chat.jsx
import React, { useState, useEffect, useRef } from 'react';
import { CryptoManager } from '../utils/Crypto';

const Chat = ({ ws, role }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [cryptoManager] = useState(() => new CryptoManager());
  const [isReady, setIsReady] = useState(false);
  const messagesEndRef = useRef(null);
  const [keyExchanged, setKeyExchanged] = useState(false);
  const [selfDestructInput, setSelfDestructInput] = useState(false);

  // Key exchange handler
  useEffect(() => {
    if (!ws || !role) return;
    if (keyExchanged) return;
    // Initiate key exchange
    ws.send(JSON.stringify({
      type: 'key_exchange',
      clientPublicKey: cryptoManager.getPublicKey()
    }));
    setKeyExchanged(true);
  }, [ws, role, cryptoManager, keyExchanged]);

  // Message handler
  useEffect(() => {
    if (!ws) return;
    const handleMessage = (e) => {
      try {
        const message = JSON.parse(e.data);
        switch (message.type) {
          case 'peer_key':
            try {
              cryptoManager.deriveSharedSecret(message.peerPublicKey);
              setIsReady(true);
              console.log('Secure connection established!');
            } catch (error) {
              console.error('Key exchange failed:', error);
              setIsReady(false);
            }
            break;
          case 'relay':
            if (message.subtype === 'message') {
              try {
                const decrypted = cryptoManager.decryptMessage(message.content);
                const isSelfDestruct = message.selfDestruct === true;
                const msgObj = {
                  text: decrypted,
                  sender: message.sender === role ? 'local' : 'remote',
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
              } catch (error) {
                console.error('Decryption failed:', error);
              }
            }
            break;
        }
      } catch (err) {
        console.error('Message handling error:', err);
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, cryptoManager, role]);

  const sendMessage = () => {
    if (!input.trim() || !isReady) return;
    try {
      const encrypted = cryptoManager.encryptMessage(input);
      ws.send(JSON.stringify({
        type: 'relay',
        subtype: 'message',
        content: encrypted,
        selfDestruct: selfDestructInput
      }));
      const msgObj = {
        text: input,
        sender: 'local',
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
      setInput('');
      setSelfDestructInput(false);
    } catch (err) {
      console.error('Encryption error:', err);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="chat-container">
      <div className="security-status">
        {isReady ? '🔒 Secure' : '⚠️ Connecting...'}
      </div>
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.sender}`}> 
            <span>{msg.text}</span>
            <span className="timestamp">{msg.timestamp}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder={isReady ? 'Type your message...' : 'Waiting for secure connection...'}
          disabled={!isReady}
        />
        <button onClick={() => setSelfDestructInput(v => !v)} type="button" style={{background:selfDestructInput?'#e74c3c':'#e9ecef',color:selfDestructInput?'#fff':'#333',marginRight:'0.5em'}}>
          {selfDestructInput ? '💣' : '💬'}
        </button>
        <button onClick={sendMessage} disabled={!isReady || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default Chat;