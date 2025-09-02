// config.js
import { getConfig } from './lib/configdb.js'

let configCache = {
  PREFIX: '.',
  MODE: 'public',
  CREATOR: '2349133354644@s.whatsapp.net',
  OWNER_NUMBERS: ['2349133354644'],
  MONGODB_URI: '',
  BOT_NAME: 'Xylo-MD',
  FOOTER: '© Powered by DavidX',
  ANTIDELETE_MODE: 'off',
  AUTOVIEW_STATUS: true,
  AUTOLIKE_STATUS: true,
  SESSION_ID: process.env.SESSION_ID || ''
}
export async function initConfig() {
  for (const key of Object.keys(configCache)) {
    const value = await getConfig(key.toLowerCase())
    if (value !== undefined) {
      configCache[key] = value
    }
  }
}
export function updateCache(key, value) {
  const upperKey = key.toUpperCase()
  if (configCache.hasOwnProperty(upperKey)) {
    configCache[upperKey] = value
  }
}
const config = new Proxy(configCache, {
  set() {
    throw new Error('Direct assignment not allowed. Use setConfig().')
  }
})

export default config
