import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Authenticator } from '../api/client.js';

export interface FakeCredential {
  id: Buffer;
  rpId: string;
  userHandle: string;
  privateKey: KeyObject;
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export class FakeAuthenticator implements Authenticator {
  constructor(
    readonly origin: string,
    readonly credentials: FakeCredential[] = [],
  ) {}

  at(origin: string): FakeAuthenticator {
    return new FakeAuthenticator(origin, this.credentials);
  }

  async create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const id = randomBytes(16);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([UP | UV | AT]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      id,
      cbor(cose),
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    this.credentials.push({ id, rpId, userHandle: options.user.id, privateKey });
    const encodedId = id.toString('base64url');
    return {
      id: encodedId,
      rawId: encodedId,
      type: 'public-key',
      response: {
        clientDataJSON: this.clientData('webauthn.create', options.challenge),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  async get(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    const allowed = options.allowCredentials?.map((c) => c.id) ?? [];
    const credential = this.credentials.find(
      (c) => c.rpId === rpId && (!allowed.length || allowed.includes(c.id.toString('base64url'))),
    );
    if (!credential) throw new Error(`no passkey for ${rpId}`);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([UP | UV]), Buffer.alloc(4)]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]), credential.privateKey);
    const id = credential.id.toString('base64url');
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  private clientData(type: string, challenge: string): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false })).toString('base64url');
  }
}

function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cbor(value: Cbor): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}
