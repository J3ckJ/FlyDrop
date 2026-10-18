import { createLinuxPlatform } from './linux.js';
import { createMacosPlatform } from './macos.js';
import { createMockPlatform } from './mock.js';
import { createWindowsPlatform } from './windows.js';

export function detectPlatform() {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    default: return 'linux';
  }
}

export function createPlatform(kind = 'auto', options = {}) {
  const name = kind === 'auto' ? detectPlatform() : kind;
  switch (name) {
    case 'mock': return createMockPlatform(options);
    case 'windows': return createWindowsPlatform();
    case 'macos': return createMacosPlatform();
    case 'linux': return createLinuxPlatform();
    default: {
      const unknown = name;
      throw new Error(`Неизвестная платформа ${unknown}`);
    }
  }
}
