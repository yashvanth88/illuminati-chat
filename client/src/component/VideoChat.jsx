import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CryptoManager } from '../utils/Crypto';
import './VideoChat.css';
import crypto from 'crypto-browserify';
import * as faceapi from 'face-api.js';

const VideoChat = ({ ws, role }) => {
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const messagesEndRef = useRef(null);
  const [cryptoManager] = useState(new CryptoManager());
  const [peerConnection, setPeerConnection] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [isCaller, setIsCaller] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [incomingCall, setIncomingCall] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const iceCandidateBuffer = useRef([]);
  const hasRemoteDescription = useRef(false);
  const isProcessingCandidates = useRef(false);
  const bufferedCandidates = useRef([]);
  const [keyExchanged, setKeyExchanged] = useState(false);
  const [sharedSecretHash, setSharedSecretHash] = useState('');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const canvasRef = useRef();
  // Store last detected landmarks and timestamp
  const lastLandmarksRef = useRef(null);
  const lastDetectionTimeRef = useRef(0);
  const glassesImg = new window.Image();
  glassesImg.src = '/glasses.png';
  glassesImg.onload = () => console.log('Glasses image loaded', glassesImg.width, glassesImg.height);
  glassesImg.onerror = () => console.log('Glasses image failed to load');
  // Store the original webcam stream for toggling
  const webcamStreamRef = useRef(null);
  // Store the canvas stream for reuse
  const canvasStreamRef = useRef(null);
  // Track the current stream type
  const currentStreamTypeRef = useRef('webcam'); // 'webcam' or 'canvas'
  const isSettingStreamRef = useRef(false);
  const [videoReady, setVideoReady] = useState(false);
  const hiddenVideoRef = useRef();
  // Add state for mic/cam
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  // Add state for draggable self-view position
  const [selfViewPos, setSelfViewPos] = useState({ top: 40, left: window.innerWidth - 220 });
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selfDestructInput, setSelfDestructInput] = useState(false);
  const [ephemeralVideo, setEphemeralVideo] = useState(null); // Placeholder for ephemeral video
  const [roomDuration, setRoomDuration] = useState(300); // default 5 min
  const [roomCountdown, setRoomCountdown] = useState(null);
  const [roomCreated, setRoomCreated] = useState(false);

  // WebRTC signaling helpers (offer/answer/candidate)
  const handleOffer = useCallback(async (offer) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const encrypted = cryptoManager.encryptMessage(JSON.stringify(answer));
    ws.send(JSON.stringify({
      type: 'relay',
      subtype: 'webrtc_answer',
      content: encrypted
    }));
  }, [peerConnection, ws, cryptoManager]);

  const handleAnswer = useCallback(async (answer) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }, [peerConnection]);

  const handleCandidate = useCallback(async (candidate) => {
    if (!peerConnection) return;
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }, [peerConnection]);

  // Key exchange handler
  useEffect(() => {
    if (!ws || !role) return;
    if (keyExchanged) return;
    ws.send(JSON.stringify({
      type: 'key_exchange',
      clientPublicKey: cryptoManager.getPublicKey()
    }));
    setKeyExchanged(true);
  }, [ws, role, cryptoManager, keyExchanged]);

  // WebRTC and signaling logic (adapted to use relay)
  useEffect(() => {
    const initWebRTC = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: true, 
          audio: true 
        });
        webcamStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            {
              urls: 'turn:numb.viagenie.ca',
              credential: 'muazkh',
              username: 'webrtc@live.com'
            }
          ],
          iceCandidatePoolSize: 10,
          bundlePolicy: 'max-bundle',
          rtcpMuxPolicy: 'require',
          iceTransportPolicy: 'all'
        });
        // Add tracks from the correct stream (webcam or canvas)
        const addTracks = (mediaStream) => {
          mediaStream.getTracks().forEach(track => {
            pc.addTrack(track, mediaStream);
        });
        };
        // Initially add webcam stream
        addTracks(stream);
        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            const stream = event.streams[0];
            if (remoteVideoRef.current) {
              if (stream.getTracks().length > 0) {
                remoteVideoRef.current.srcObject = stream;
                remoteVideoRef.current.onloadedmetadata = () => {
                  remoteVideoRef.current.play().catch(() => {});
                  setStatus('connected');
                };
              }
            }
          }
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            const encrypted = cryptoManager.encryptMessage(JSON.stringify(e.candidate));
            ws.send(JSON.stringify({
              type: 'relay',
              subtype: 'webrtc_ice_candidate',
              candidate: encrypted
            }));
          }
        };
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            setStatus('disconnected');
            endCall();
          } else if (pc.iceConnectionState === 'connected') {
            setStatus('connected');
          }
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            setStatus('error');
            endCall();
          } else if (pc.connectionState === 'connected') {
            setStatus('connected');
          }
        };
        setPeerConnection(pc);
        setStatus('ready');
        // Store for later switching
        pc.__currentStream = stream;
      } catch (err) {
        setStatus('error');
      }
    };
    if (ws && isReady) {
      initWebRTC();
    }
    return () => {
      if (peerConnection) {
        peerConnection.close();
      }
    };
  }, [ws, isReady]);

  // Helper to ensure canvas is ready before captureStream
  const getCanvasStream = () => {
    if (!canvasRef.current) return null;
    const canvas = canvasRef.current;
    if (canvas.width === 0 || canvas.height === 0) return null;
    // Only create the canvas stream ONCE per filter session
    if (!canvasStreamRef.current) {
      canvasStreamRef.current = canvas.captureStream(30);
    }
    return canvasStreamRef.current;
  };

  // Set videoReady when hidden video metadata is loaded
  useEffect(() => {
    const video = hiddenVideoRef.current;
    if (!video) return;
    const handleLoadedMetadata = () => {
      setVideoReady(true);
      console.log('[VideoChat] Hidden video metadata loaded:', video.videoWidth, video.videoHeight);
    };
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    return () => video.removeEventListener('loadedmetadata', handleLoadedMetadata);
  }, []);

  // When webcam stream is available, set it to both hidden and visible video
  useEffect(() => {
    if (webcamStreamRef.current) {
      if (hiddenVideoRef.current) {
        hiddenVideoRef.current.srcObject = webcamStreamRef.current;
        hiddenVideoRef.current.play().catch(() => {});
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webcamStreamRef.current;
        localVideoRef.current.play().catch(() => {});
      }
    }
  }, [webcamStreamRef.current]);

  // Replace the drawFilter function with a minimal canvas test
  useEffect(() => {
    let animationId;
    let isMounted = true;
    if (!filterEnabled) return;
    if (!videoReady) {
      console.log('[VideoChat] Filter enabled but video not ready');
      return;
    }
    const runFaceFilter = async () => {
      // Load models if not already loaded
      try {
        if (!faceapi.nets.tinyFaceDetector.params && !faceapi.nets.faceLandmark68Net.params) {
          await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
          await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
        }
      } catch (err) {
        console.error('[VideoChat] face-api.js model load error:', err);
        return;
      }
      const video = hiddenVideoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.log('[VideoChat] Hidden video not ready for drawing:', video.videoWidth, video.videoHeight);
        return;
      }
      // Set canvas size to match video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      const draw = async () => {
        if (!isMounted) return;
        if (!filterEnabled) return;
        if (!video || !canvas) return;
        if (video.videoWidth === 0 || video.videoHeight === 0) {
          console.log('[VideoChat] Hidden video not ready in draw loop:', video.videoWidth, video.videoHeight);
          animationId = requestAnimationFrame(draw);
          return;
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Detect face and landmarks
        let detection = null;
        try {
          detection = await faceapi.detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks();
        } catch (err) {
          console.error('[VideoChat] face-api.js detection error:', err);
        }
        if (detection && detection.landmarks) {
          // Get eye positions
          const leftEye = detection.landmarks.getLeftEye();
          const rightEye = detection.landmarks.getRightEye();
          if (leftEye && rightEye) {
            // Calculate glasses position/size
            const eyeCenterX = (leftEye[0].x + rightEye[3].x) / 2;
            const eyeCenterY = (leftEye[0].y + rightEye[3].y) / 2;
            const eyeDist = Math.hypot(rightEye[3].x - leftEye[0].x, rightEye[3].y - leftEye[0].y);
            const glassesWidth = eyeDist * 2.2;
            const glassesHeight = glassesWidth * 0.5;
            const glassesX = eyeCenterX - glassesWidth / 2;
            const glassesY = eyeCenterY - glassesHeight / 2;
            context.save();
            context.drawImage(glassesImg, glassesX, glassesY, glassesWidth, glassesHeight);
            context.restore();
          }
        }
        animationId = requestAnimationFrame(draw);
      };
      draw();
    };
    runFaceFilter();
    return () => {
      isMounted = false;
      if (animationId) cancelAnimationFrame(animationId);
    };
  }, [filterEnabled, glassesImg, videoReady]);

  // Switch outgoing stream when filter is toggled
  useEffect(() => {
    if (!peerConnection) return;
    const replaceVideoTrack = (newStream) => {
      const senders = peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        const newVideoTrack = newStream.getVideoTracks()[0];
        if (newVideoTrack && videoSender.track !== newVideoTrack) {
          videoSender.replaceTrack(newVideoTrack);
          console.log('replaceVideoTrack: replaced video track with', newStream);
        }
      }
    };
    // Always ensure canvas is sized and ready
    if (canvasRef.current && localVideoRef.current) {
      const video = localVideoRef.current;
      const canvas = canvasRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.log('[VideoChat] Not switching streams: video not ready', video.videoWidth, video.videoHeight);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    if (filterEnabled) {
      // Only switch if not already on canvas
      if (currentStreamTypeRef.current !== 'canvas') {
        if (canvasRef.current && canvasRef.current.width > 0 && canvasRef.current.height > 0) {
          if (!canvasStreamRef.current) {
            canvasStreamRef.current = canvasRef.current.captureStream(30);
            console.log('Created new canvas stream');
          }
          replaceVideoTrack(canvasStreamRef.current);
          if (localVideoRef.current && localVideoRef.current.srcObject !== canvasStreamRef.current) {
            localVideoRef.current.srcObject = canvasStreamRef.current;
            console.log('Stream switch: local preview set to canvas stream');
          }
          currentStreamTypeRef.current = 'canvas';
        } else {
          console.log('[VideoChat] Canvas not ready, will not switch', canvasRef.current?.width, canvasRef.current?.height);
        }
      } else {
        console.log('Already on canvas stream, not switching');
      }
    } else {
      // Only switch if not already on webcam
      if (currentStreamTypeRef.current !== 'webcam') {
        if (webcamStreamRef.current) {
          replaceVideoTrack(webcamStreamRef.current);
          if (localVideoRef.current && localVideoRef.current.srcObject !== webcamStreamRef.current) {
            localVideoRef.current.srcObject = webcamStreamRef.current;
            console.log('Stream switch: local preview set to webcam stream');
          }
          currentStreamTypeRef.current = 'webcam';
          // Do NOT set canvasStreamRef.current = null here; only on call end/unmount
        } else {
          console.log('[VideoChat] Webcam stream not ready, will not switch');
        }
      } else {
        console.log('Already on webcam stream, not switching');
      }
    }
    // Only run this effect when filterEnabled changes!
    // eslint-disable-next-line
  }, [filterEnabled, peerConnection, videoReady]);

  // On call end/unmount, clean up canvas stream
  useEffect(() => {
    return () => {
      if (canvasStreamRef.current) {
        canvasStreamRef.current.getTracks().forEach(track => track.stop());
        canvasStreamRef.current = null;
      }
    };
  }, []);

  // Message handler
  useEffect(() => {
    if (!ws) return;
    const handleMessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[VideoChat] Received message:', message.type, message.subtype || '', message);
        switch (message.type) {
          case 'peer_key':
            try {
              cryptoManager.deriveSharedSecret(message.peerPublicKey);
              setIsReady(true);
              console.log('[VideoChat] Secure connection established!');
            } catch (error) {
              setIsReady(false);
              console.error('[VideoChat] Key exchange failed:', error);
            }
            break;
          case 'relay':
            if (message.subtype === 'webrtc_offer') {
              console.log('[VideoChat] Received relay/webrtc_offer');
              // Decrypt and handle offer
              const offer = JSON.parse(cryptoManager.decryptMessage(message.content));
              handleOffer(offer);
            } else if (message.subtype === 'webrtc_answer') {
              console.log('[VideoChat] Received relay/webrtc_answer');
              // Decrypt and handle answer
              const answer = JSON.parse(cryptoManager.decryptMessage(message.content));
              handleAnswer(answer);
            } else if (message.subtype === 'webrtc_ice_candidate') {
              console.log('[VideoChat] Received relay/webrtc_ice_candidate');
              // Decrypt and handle ICE candidate
              const candidate = JSON.parse(cryptoManager.decryptMessage(message.candidate));
              handleCandidate(candidate);
            } else if (message.subtype === 'message') {
              // Encrypted chat message
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
            } else if (message.subtype === 'ephemeral_video') {
              // Placeholder: handle ephemeral video message
              setEphemeralVideo({
                url: message.url,
                sender: message.sender === role ? 'local' : 'remote',
                timestamp: new Date().toLocaleTimeString()
              });
              // Remove video after 10 seconds
              setTimeout(() => setEphemeralVideo(null), 10000);
            }
            break;
        }
      } catch (err) {
        console.error('[VideoChat] Error handling message:', err);
      }
    };
    ws.addEventListener('message', handleMessage);
    return () => ws.removeEventListener('message', handleMessage);
  }, [ws, cryptoManager, role, handleOffer, handleAnswer, handleCandidate]);

  // Compute shared secret hash for verification
  useEffect(() => {
    if (cryptoManager.sharedSecret) {
      // Hash the shared secret and show first 8 hex chars
      const hash = crypto.createHash('sha256').update(cryptoManager.sharedSecret).digest('hex');
      setSharedSecretHash(hash.slice(0, 8));
    } else {
      setSharedSecretHash('');
    }
  }, [cryptoManager.sharedSecret]);

  // Start call (host initiates)
  const startCall = async () => {
    if (!peerConnection) {
      console.log('[startCall] No peerConnection, aborting');
      return;
    }
    setIsCaller(true);
    console.log('[startCall] Creating offer...');
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('[startCall] Offer created and set as local description:', offer);
    const encrypted = cryptoManager.encryptMessage(JSON.stringify(offer));
    ws.send(JSON.stringify({
      type: 'relay',
      subtype: 'webrtc_offer',
      content: encrypted
    }));
    console.log('[startCall] Sent relay message with webrtc_offer');
  };

  // End call
  const endCall = () => {
    if (peerConnection) peerConnection.close();
    setPeerConnection(null);
    setStatus('disconnected');
  };

  // Chat message send
  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !isReady) return;
    const encrypted = cryptoManager.encryptMessage(newMessage);
    ws.send(JSON.stringify({
      type: 'relay',
      subtype: 'message',
      content: encrypted,
      selfDestruct: selfDestructInput
    }));
    const msgObj = {
      text: newMessage,
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
    setNewMessage('');
    setSelfDestructInput(false);
  };

  // Add handlers for toggling mic/cam
  const toggleMic = () => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !micEnabled;
      });
      setMicEnabled(m => !m);
    }
  };
  const toggleCam = () => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getVideoTracks().forEach(track => {
        track.enabled = !camEnabled;
      });
      setCamEnabled(c => !c);
    }
  };

  // Drag handlers
  const handleSelfViewMouseDown = (e) => {
    setDragging(true);
    setDragOffset({
      x: e.clientX - selfViewPos.left,
      y: e.clientY - selfViewPos.top,
    });
    e.preventDefault();
  };
  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e) => {
      setSelfViewPos(pos => ({
        top: Math.max(0, Math.min(window.innerHeight - 120, e.clientY - dragOffset.y)),
        left: Math.max(0, Math.min(window.innerWidth - 180, e.clientX - dragOffset.x)),
      }));
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, dragOffset]);

  // When host creates a room, allow setting duration and send it to server
  const createRoom = () => {
    if (role !== 'host') return;
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
          setStatus('disconnected');
          setRoomCreated(false);
          setRoomCountdown(null);
          if (peerConnection) peerConnection.close();
        }
      } catch {}
    };
    ws.addEventListener('message', handleRoomEvents);
    return () => ws.removeEventListener('message', handleRoomEvents);
  }, [ws, peerConnection]);

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
    <div className="video-chat-horizontal-container">
      <div className="video-area">
        <div className="security-status">
          {isReady ? '🔒 Secure' : '⚠️ Connecting...'}
        </div>
        <div className="shared-secret-status">
          {sharedSecretHash ? (
            <span>Shared Secret: <code style={{fontWeight:'bold',fontSize:'1.1em'}}>{sharedSecretHash}</code> <span style={{color:'#16a085'}}>Verify with peer</span></span>
          ) : (
            <span style={{color:'#e67e22'}}>Shared secret not established!</span>
          )}
        </div>
        <div className="whatsapp-video-section">
          <video ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
          {/* Self-view floating window: show canvas if filter is enabled, else show video */}
          <div
            className="local-video-floating-draggable"
            style={{ top: selfViewPos.top, left: selfViewPos.left }}
            onMouseDown={handleSelfViewMouseDown}
          >
            {filterEnabled ? (
              <canvas
                ref={canvasRef}
                style={{ width: '100%', height: '100%', borderRadius: '1em', objectFit: 'cover', background: '#333' }}
              />
            ) : (
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                style={{ width: '100%', height: '100%', borderRadius: '1em', objectFit: 'cover', background: '#333' }}
              />
            )}
            {/* Hidden video for canvas filter, always off-screen and playing */}
            <video
              ref={hiddenVideoRef}
              autoPlay
              muted
              playsInline
              style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, pointerEvents: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
            />
            {!videoReady && <div style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',background:'#222',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100}}>Waiting for webcam...</div>}
          </div>
          <div className="video-label remote">Peer</div>
          <div className="video-label local">You</div>
          <div className="controls">
            <button onClick={toggleMic} title={micEnabled ? 'Mute Mic' : 'Unmute Mic'}>{micEnabled ? '🎤' : '🔇'}</button>
            <button onClick={toggleCam} title={camEnabled ? 'Turn Off Camera' : 'Turn On Camera'}>{camEnabled ? '📷' : '🚫'}</button>
            {role === 'host' && isReady && status === 'ready' && (
              <button onClick={startCall} title="Start Call">📞</button>
            )}
            <button onClick={endCall} title="End Call">❌</button>
            <button onClick={() => {
              setFilterEnabled(f => {
                console.log('Toggling filter, previous:', f, 'next:', !f);
                return !f;
              });
            }} title="Toggle Filter">
              {filterEnabled ? '🙈' : '🕶️'}
            </button>
          </div>
        </div>
      </div>
      <div className="chat-section-right">
        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.sender}`}>
              <span>{msg.text}</span>
              <span className="timestamp">{msg.timestamp}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <form className="input-area" onSubmit={sendMessage}>
          <input
            type="text"
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder={isReady ? 'Type your message...' : 'Waiting for secure connection...'}
            disabled={!isReady}
          />
          <button onClick={() => setSelfDestructInput(v => !v)} type="button" style={{background:selfDestructInput?'#e74c3c':'#e9ecef',color:selfDestructInput?'#fff':'#333',marginRight:'0.5em'}}>
            {selfDestructInput ? '💣' : '💬'}
          </button>
          <button type="submit" disabled={!isReady || !newMessage.trim()}>
            Send
          </button>
        </form>
        {ephemeralVideo && (
          <div className="ephemeral-video-message">
            <video src={ephemeralVideo.url} autoPlay controls style={{width:'100%'}} />
            <div className="timestamp">{ephemeralVideo.timestamp} (Ephemeral Video)</div>
          </div>
        )}
        {role === 'host' && !roomCreated && (
          <div style={{margin:'1em 0'}}>
            <label>Session Duration (seconds): </label>
            <input type="number" min="60" max="3600" value={roomDuration} onChange={e => setRoomDuration(Number(e.target.value))} style={{width:'6em',marginRight:'1em'}} />
            <button onClick={createRoom}>Create Room</button>
          </div>
        )}
        {roomCreated && roomCountdown !== null && (
          <div style={{margin:'1em 0',color:'#e67e22',fontWeight:'bold'}}>Session ends in: {roomCountdown}s</div>
        )}
      </div>
    </div>
  );
};

export default VideoChat;