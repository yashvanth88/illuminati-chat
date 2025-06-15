// Crypto.jsx
import JSChaCha20 from 'js-chacha20';
import crypto from 'crypto-browserify';

export class CryptoManager {
  constructor() {
    this.ecdh = crypto.createECDH('secp521r1');
    this.ecdh.generateKeys();
    this.sharedSecret = null;
  }

  getPublicKey() {
    return this.ecdh.getPublicKey('base64');
  }

  deriveSharedSecret(peerPublicKey) {
    try {
      const peerKeyBuffer = Buffer.from(peerPublicKey, 'base64');
      
      // Validate public key format
      if (peerKeyBuffer.length !== 133 || peerKeyBuffer[0] !== 0x04) {
        throw new Error('Invalid public key format');
      }

      this.sharedSecret = this.ecdh.computeSecret(peerKeyBuffer);
      
      // Ensure we have at least 32 bytes for AES-256
      if (this.sharedSecret.length < 32) {
        throw new Error('Insufficient key length');
      }
    } catch (error) {
      this.sharedSecret = null;
      throw error;
    }
  }

  encryptMessage(message) {
    if (!this.sharedSecret) throw new Error('No shared secret');
    const key = this.sharedSecret.subarray(0, 32);
    const nonce = crypto.randomBytes(12); // 12 bytes for ChaCha20
    const msgBytes = new TextEncoder().encode(message);
    const cipherBytes = new JSChaCha20(key, nonce).encrypt(msgBytes);
    return {
      nonce: Buffer.from(nonce).toString('hex'),
      content: Buffer.from(cipherBytes).toString('hex')
    };
  }

  decryptMessage(encrypted) {
    if (!this.sharedSecret) throw new Error('No shared secret');
    const key = this.sharedSecret.subarray(0, 32);
    const nonce = Buffer.from(encrypted.nonce, 'hex');
    const cipherBytes = Buffer.from(encrypted.content, 'hex');
    const plainBytes = new JSChaCha20(key, nonce).decrypt(cipherBytes);
    return new TextDecoder().decode(plainBytes);
  }
}