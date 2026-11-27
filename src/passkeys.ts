import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Clock } from './adapters/clock.js';
import { HosError } from './core.js';
import type { Store } from './store.js';
import { ownerSettings } from './owner.js';

const CHALLENGE_MS = 5 * 60_000;
const SESSION_MS = 30 * 24 * 60 * 60_000;
const OWNER = new TextEncoder().encode('hos-owner');

interface Challenge {
  kind: 'register' | 'login';
  rpId: string;
  expiresAt: number;
}

export class Passkeys {
  private readonly challenges = new Map<string, Challenge>();
  private readonly codeFile: string;
  private code: string | null;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    dataDir: string,
  ) {
    this.codeFile = join(dataDir, 'enrolment-code');
    this.code = randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10).toLowerCase();
    writeFileSync(this.codeFile, `${this.code}\n`, { mode: 0o600 });
  }

  get enrolmentCode(): string | null {
    return this.code;
  }

  status(origin: string, token: string | undefined): { registered: boolean; signedIn: boolean } {
    return { registered: this.store.passkeys(rpIdOf(origin)).length > 0, signedIn: this.isSignedIn(origin, token) };
  }

  registeredOrigins(): string[] {
    return this.store.passkeyRpIds().map((rpId) => (rpId === 'localhost' ? 'http://localhost' : `https://${rpId}`));
  }

  isSignedIn(origin: string, token: string | undefined): boolean {
    const session = token ? this.store.getSession(hash(token)) : undefined;
    return !!session && session.rpId === rpIdOf(origin) && session.expiresAt > this.clock.now();
  }

  async registrationOptions(origin: string, code: string | undefined): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rpId = rpIdOf(origin);
    this.refuseSecondPasskey(origin);
    this.checkCode(code);
    const options = await generateRegistrationOptions({
      rpName: 'hos',
      rpID: rpId,
      userName: ownerSettings().name?.toLowerCase() ?? 'hos',
      userDisplayName: ownerSettings().name ?? 'hos owner',
      userID: OWNER,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    });
    this.remember(options.challenge, { kind: 'register', rpId });
    return options;
  }

  async register(origin: string, code: string | undefined, response: RegistrationResponseJSON): Promise<string> {
    const rpId = rpIdOf(origin);
    this.checkCode(code);
    const challenge = this.take(response.response.clientDataJSON, (c) => c.kind === 'register' && c.rpId === rpId);
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    }).catch((error: Error) => refuse(error.message));
    if (!verification.verified) refuse('the passkey could not be verified');
    this.refuseSecondPasskey(origin);
    this.checkCode(code);
    this.code = null;
    rmSync(this.codeFile, { force: true });
    const { credential } = verification.registrationInfo;
    this.store.insertPasskey({
      id: credential.id,
      rpId,
      publicKey: credential.publicKey,
      transports: credential.transports ?? [],
      createdAt: this.clock.now(),
    });
    return this.startSession(rpId, credential.id);
  }

  async loginOptions(origin: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.requestOptions(origin, { kind: 'login' });
  }

  async login(origin: string, response: AuthenticationResponseJSON): Promise<string> {
    const passkeyId = await this.verifyAssertion(origin, response, (c) => c.kind === 'login');
    return this.startSession(rpIdOf(origin), passkeyId);
  }

  private async requestOptions(origin: string, challenge: Omit<Challenge, 'rpId' | 'expiresAt'>) {
    const rpId = rpIdOf(origin);
    const passkeys = this.store.passkeys(rpId);
    if (!passkeys.length) throw new HosError(409, `no passkey is registered for ${origin} yet; register one first`);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials: [],
    });
    this.remember(options.challenge, { ...challenge, rpId });
    return options;
  }

  private async verifyAssertion(
    origin: string,
    response: AuthenticationResponseJSON,
    matches: (challenge: Challenge) => boolean,
  ): Promise<string> {
    const rpId = rpIdOf(origin);
    const challenge = this.take(response.response.clientDataJSON, (c) => c.rpId === rpId && matches(c));
    const passkey = this.store.passkeys(rpId).find((p) => p.id === response.id);
    if (!passkey) refuse('that passkey isn’t registered with hos');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: { id: passkey.id, publicKey: passkey.publicKey, counter: 0, transports: passkey.transports },
    }).catch((error: Error) => refuse(error.message));
    if (!verification.verified) refuse('the passkey could not be verified');
    return passkey.id;
  }

  private refuseSecondPasskey(origin: string): void {
    if (this.store.passkeys(rpIdOf(origin)).length) {
      throw new HosError(409, `a passkey is already registered for ${origin}; sign in with it`);
    }
  }

  private checkCode(code: string | undefined): void {
    const expected = this.code ? Buffer.from(this.code) : null;
    const given = Buffer.from(code?.trim().toLowerCase() ?? '');
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HosError(
        403,
        this.code
          ? 'a new passkey needs the one-time setup code hos printed when it started (also in enrolment-code in its data folder)'
          : 'the setup code was used; restart hos for a new one',
      );
    }
  }

  private startSession(rpId: string, passkeyId: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    this.store.insertSession(hash(token), { rpId, passkeyId, expiresAt: now + SESSION_MS }, now);
    return token;
  }

  private remember(challenge: string, details: Omit<Challenge, 'expiresAt'>): void {
    const now = this.clock.now();
    for (const [key, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(key);
    this.challenges.set(challenge, { ...details, expiresAt: now + CHALLENGE_MS });
  }

  private take(clientDataJSON: string, matches: (challenge: Challenge) => boolean): string {
    let challenge: string | undefined;
    try {
      challenge = (JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: string }).challenge;
    } catch {}
    const found = challenge ? this.challenges.get(challenge) : undefined;
    if (!challenge || !found || found.expiresAt <= this.clock.now() || !matches(found)) {
      refuse('that passkey challenge is unknown or expired; try again');
    }
    this.challenges.delete(challenge);
    return challenge;
  }
}

function rpIdOf(origin: string): string {
  return new URL(origin).hostname;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function refuse(message: string): never {
  throw new HosError(401, message);
}
