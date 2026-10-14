import 'reflect-metadata';
import { webcrypto, randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
const pem = value => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(value).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
// RFC 5280 NameConstraints: only localhost and private IPv4 ranges, never public DNS names.
function der(tag, bytes) {
  const data = Buffer.from(bytes);
  const length = data.length < 128 ? [data.length] : [0x81, data.length];
  return Buffer.concat([Buffer.from([tag, ...length]), data]);
}
function localNameConstraints() {
  const entries = [der(0x30, der(0x82, Buffer.from('localhost')))];
  for (const bytes of [[127,0,0,0,255,0,0,0], [10,0,0,0,255,0,0,0], [172,16,0,0,255,240,0,0], [192,168,0,0,255,255,0,0]]) entries.push(der(0x30, der(0x87, bytes)));
  return new x509.Extension('2.5.29.30', true, der(0x30, der(0xa0, Buffer.concat(entries))));
}
export function emptyVault() {
  return { version: 2, hostId: randomUUID(), trusted: [], settings: { lastRecipient: '', downloadsFolder: '', launchAtLogin: false, notifications: true, autoSave: false }, issuer: null };
}
export async function generateTLS(vault, addresses) {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  const signingAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
  const now = Date.now();
  let issuerKeys;
  if (!vault.issuer || Date.parse(new X509Certificate(vault.issuer.cert).validTo) < now + 365 * 86400000) {
    issuerKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      name: `CN=FlyDrop Local ${vault.hostId.slice(0, 8)}`, serialNumber: randomBytes(16).toString('hex'),
      notBefore: new Date(now - 86400000), notAfter: new Date(now + 5 * 365 * 86400000), keys: issuerKeys, signingAlgorithm,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), localNameConstraints(), await x509.SubjectKeyIdentifierExtension.create(issuerKeys.publicKey)],
    });
    vault.issuer = { cert: certificate.toString('pem'), key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', issuerKeys.privateKey)).toString('base64') };
    vault.trusted = [];
  } else {
    issuerKeys = { privateKey: await webcrypto.subtle.importKey('pkcs8', Buffer.from(vault.issuer.key, 'base64'), algorithm, false, ['sign']) };
  }
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const ca = new x509.X509Certificate(vault.issuer.cert);
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=FlyDrop', issuer: ca.subject, serialNumber: randomBytes(16).toString('hex'),
    notBefore: new Date(now - 86400000), notAfter: new Date(now + 365 * 86400000), publicKey: keys.publicKey, signingKey: issuerKeys.privateKey, signingAlgorithm,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }, ...[...new Set(['127.0.0.1', ...addresses])].map(value => ({ type: 'ip', value }))]), await x509.SubjectKeyIdentifierExtension.create(keys.publicKey), await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey)],
  });
  return { cert: cert.toString('pem'), key: pem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), ca: vault.issuer.cert, fingerprint: new X509Certificate(vault.issuer.cert).fingerprint256 };
}
export function mobileProfile(material, hostId) {
  const certificate = new X509Certificate(material.ca);
  const name = `FlyDrop Local ${hostId.slice(0, 8)}`;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>PayloadContent</key><array><dict><key>PayloadCertificateFileName</key><string>FlyDrop.cer</string><key>PayloadContent</key><data>${certificate.raw.toString('base64')}</data><key>PayloadDescription</key><string>Только локальные IPv4 адреса и localhost. SHA-256: ${material.fingerprint}</string><key>PayloadDisplayName</key><string>${name}</string><key>PayloadIdentifier</key><string>local.flydrop.${hostId}.certificate</string><key>PayloadType</key><string>com.apple.security.root</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadVersion</key><integer>1</integer></dict></array><key>PayloadDisplayName</key><string>${name}</string><key>PayloadDescription</key><string>Локальное HTTPS-соединение с вашим Windows. Профиль содержит только публичный сертификат, без VPN и управления устройством.</string><key>PayloadIdentifier</key><string>local.flydrop.${hostId}</string><key>PayloadOrganization</key><string>FlyDrop</string><key>PayloadRemovalDisallowed</key><false/><key>PayloadType</key><string>Configuration</string><key>PayloadUUID</key><string>${randomUUID()}</string><key>PayloadVersion</key><integer>1</integer></dict></plist>`;
}

export async function openVault(directory, { encrypt, decrypt } = {}) {
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('Для хранения ключей требуется нативное защищённое хранилище Windows. Запустите Windows-приложение FlyDrop');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'vault.safe');
  let value;
  try { value = JSON.parse(Buffer.from(await decrypt(await readFile(filename))).toString('utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; value = emptyVault(); }
  if (value.version !== 2 || !Array.isArray(value.trusted) || !value.hostId) throw new Error('Некорректное защищённое хранилище');
  let writes = Promise.resolve();
  return { value, save() {
    const serialized = Buffer.from(JSON.stringify(value));
    const operation = writes.then(async () => {
      const encrypted = await encrypt(serialized);
      const temporary = path.join(directory, `vault-${randomUUID()}.tmp`);
      await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }); await rename(temporary, filename);
    });
    writes = operation.catch(() => {}); return operation;
  }, flush: () => writes };
}
