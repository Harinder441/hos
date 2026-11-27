import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HosClient } from '../src/api/client.js';
import { FakeAuthenticator } from '../src/fakes/fake-authenticator.js';

export default async function globalSetup(): Promise<void> {
  const port = Number(process.env.HOS_E2E_PORT ?? 47317);
  const passkey = new FakeAuthenticator(`http://localhost:${port}`);
  const code = readFileSync(join(process.env.HOS_E2E_DATA_DIR!, 'enrolment-code'), 'utf8').trim();
  await new HosClient(`http://127.0.0.1:${port}`, { authenticator: passkey }).registerPasskey(code);
  const [credential] = passkey.credentials;
  writeFileSync(
    join(process.env.HOS_E2E_DATA_DIR!, 'passkey.json'),
    JSON.stringify({
      credentialId: credential!.id.toString('base64'),
      rpId: credential!.rpId,
      userHandle: Buffer.from(credential!.userHandle, 'base64url').toString('base64'),
      privateKey: credential!.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    }),
  );
}
