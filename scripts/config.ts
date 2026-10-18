import { fileURLToPath } from 'node:url';
import config from '../native/build-config.json';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const nativeConfig = config;
