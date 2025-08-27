import express from 'express'
import baileys from 'baileys'
const {
  makeWASocket,
  getContentType,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  jidDecode,
  downloadContentFromMessage,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto
} = baileys
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import axios from 'axios'
import { File } from 'megajs'
import config from './config.js'
import { getConfig } from './lib/configdb.js'
import { handleGroupParticipantsUpdate } from './lib/welcomeHandler.js'
import { setupModerationDetection } from './lib/setupModerationDetection.js'
import { saveGroupMetadata, isAdmin as getGroupAdmin, isBotAdmin as getBotAdmin } from './lib/groupMeta.js'
import { handleDeletedMessage } from './lib/antideleteHandler.js'
import PhoneNumber from 'awesome-phonenumber'
import { writeExif, writeExifImg, writeExifVid, imageToWebp, videoToWebp } from './lib/exif.js'
import setupChatbotListener from './lib/chatbotListener.js'
import setupGameListener from './lib/gameListener.js'
import getBuffer from './lib/getBuffer.js'
import fileType from 'file-type'
const { fileTypeFromBuffer: FileType } = fileType

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const sessionDir = path.join(__dirname, 'sessions')
const credsPath = path.join(sessionDir, 'creds.json')
const globalPlugins = new Map()
const CREATOR_NUMBERS = [config.CREATOR, '2347013349642', '2349133354644']
const ownerNumber = ['2349133354644']
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir)

const bannedUsersPath = './lib/banned.json'
const sudoUsersPath = './lib/sudo.json'

// In-memory arrays
let bannedUsers = []
let sudoUsers = []

// Load JSON safely into arrays
function loadUserData() {
  try {
    bannedUsers = JSON.parse(fs.readFileSync(bannedUsersPath, 'utf-8'))
  } catch {
    bannedUsers = []
  }
  try {
    sudoUsers = JSON.parse(fs.readFileSync(sudoUsersPath, 'utf-8'))
  } catch {
    sudoUsers = []
  }
}

// Save helper
function saveUserData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

// Load at startup
loadUserData()

// Make them accessible to plugins
global.bannedUsers = bannedUsers
global.sudoUsers = sudoUsers
global.saveUserData = saveUserData
global.bannedUsersPath = bannedUsersPath
global.sudoUsersPath = sudoUsersPath

global.antideleteStore = new Map()
const botAdminStatus = {}
setInterval(() => global.antideleteStore.clear(), 1000 * 60 * 10)

async function loadSession() {
  try {
    if (!config.SESSION_ID) {
      console.log('⚠️ No SESSION_ID provided in config!');
      return null;
    }

    // 🌐 From Render backend (e.g. dave-auth-manager)
    if (config.SESSION_ID.startsWith('XBOT-MD**')) {
      const id = config.SESSION_ID.replace('XBOT-MD**', '');
      const { data } = await axios.get(`https://dave-auth-manager.onrender.com/files/${id}.json`);
      fs.writeFileSync(credsPath, JSON.stringify(data), 'utf8');
      console.log('✅ Xcall session loaded.');
      return data;
    }

    // ☁️ From Supabase (new format)
    if (config.SESSION_ID.startsWith('DAVE-S*F=')) {
      const idv = config.SESSION_ID.replace('DAVE-S*F=', '');
      const supabaseUrl = `https://dave-sess.onrender.com/download/${idv}`;
      
      const { data } = await axios.get(supabaseUrl);
      fs.writeFileSync(credsPath, JSON.stringify(data), 'utf8');
      console.log('✅ Supabase session loaded (DAVE-S*F).');
      return data;
    }

    // 🗃️ From MEGA
    if (config.SESSION_ID.startsWith('XBOT-MD~')) {
      const megaCode = config.SESSION_ID.replace('XBOT-MD~', '');
      if (!megaCode.includes('#')) throw new Error('Invalid MEGA session: missing hash (#key)');

      const megaLink = `https://mega.nz/file/${megaCode}`;
      const file = File.fromURL(megaLink);
      const data = await new Promise((resolve, reject) => {
        file.download((err, fileData) => err ? reject(err) : resolve(fileData));
      });

      fs.writeFileSync(credsPath, data);
      console.log('✅ MEGA session downloaded and saved.');
      return JSON.parse(data.toString());
    }

    throw new Error('Unsupported SESSION_ID format.');
  } catch (e) {
    console.error('❌ Session error:', e.message);
    return null;
  }
}

async function connectToWA() {
  console.log('📩 Connecting to WhatsApp...')
  const creds = await loadSession()
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir, { creds: creds || undefined })
  const { version } = await fetchLatestBaileysVersion()

  const Dave = makeWASocket({
  logger: P({ level: 'silent' }),
  printQRInTerminal: !creds,
  browser: Browsers.macOS('Firefox'),
  auth: state,
  syncFullHistory: true,
  version,
  getMessage: async () => ({})
})

// 📌 Inject Utility Methods

Dave.replySmart = async (jid, content, quoted = true) => {
  const quote = quoted
    ? {
        key: {
          remoteJid: "status@broadcast",
          fromMe: false,
          participant: "13135550002@s.whatsapp.net"
        },
        message: {
          contactMessage: {
            displayName: "DaveTech",
            vcard: `BEGIN:VCARD
VERSION:3.0
FN:Meta AI
TEL;type=CELL;type=VOICE;waid=13135550002:+1 3135550002
END:VCARD`
          }
        }
      }
    : undefined

  return Dave.sendMessage(jid, content, { quoted: quote })
}
  
Dave.decodeJid = (jid) => {
  try {
    const decoded = jidDecode(jid)
    if (!decoded?.user || !decoded?.server) return jid
    return decoded.device
      ? `${decoded.user}:${decoded.device}@${decoded.server}`
      : `${decoded.user}@${decoded.server}`
  } catch {
    return jid
  }
}

Dave.downloadMediaMessage = async (message) => {
  const type = Object.keys(message.message || {})[0]
  const stream = await downloadContentFromMessage(message.message[type], type.replace(/Message/i, ''))
  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }
  return buffer
}

Dave.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
  const buffer = await Dave.downloadMediaMessage(message)
  const type = await FileType(buffer)
  const trueFileName = attachExtension ? `${filename}.${type?.ext}` : filename
  fs.writeFileSync(trueFileName, buffer)
  return trueFileName
}

Dave.sendImageAsSticker = async (jid, buffer, options = {}) => {
  let stickerBuffer = await writeExifImg(buffer, options)
  await Dave.sendMessage(jid, { sticker: { url: stickerBuffer }, ...options }, { quoted: options.quoted })
}

Dave.sendVideoAsSticker = async (jid, buffer, options = {}) => {
  let stickerBuffer = await writeExifVid(buffer, options)
  await Dave.sendMessage(jid, { sticker: { url: stickerBuffer }, ...options }, { quoted: options.quoted })
}

Dave.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
  let mime = ''
  let res = await axios.head(url)
  mime = res.headers['content-type']
  if (mime.includes('image')) {
    return Dave.sendMessage(jid, { image: await getBuffer(url), caption, ...options }, { quoted })
  } else if (mime.includes('video')) {
    return Dave.sendMessage(jid, { video: await getBuffer(url), caption, ...options }, { quoted })
  } else if (mime.includes('audio')) {
    return Dave.sendMessage(jid, { audio: await getBuffer(url), caption, ...options }, { quoted })
  } else {
    return Dave.sendMessage(jid, { document: await getBuffer(url), mimetype: mime, caption, ...options }, { quoted })
  }
}

Dave.sendFile = async (jid, path, fileName, quoted = {}, options = {}) => {
  let buffer = fs.existsSync(path) ? fs.readFileSync(path) : await getBuffer(path)
  let type = await FileType(buffer) || { mime: 'application/octet-stream', ext: '.bin' }
  return Dave.sendMessage(jid, {
    document: buffer,
    mimetype: type.mime,
    fileName: fileName || `file.${type.ext}`,
    ...options
  }, { quoted })
}

Dave.sendMedia = async (jid, path, fileName = '', caption = '', quoted = '', options = {}) => {
  let buffer = fs.existsSync(path) ? fs.readFileSync(path) : await getBuffer(path)
  let type = await FileType(buffer)
  let mime = type?.mime || 'application/octet-stream'
  let message = {}
  if (mime.includes('image')) message.image = buffer
  else if (mime.includes('video')) message.video = buffer
  else if (mime.includes('audio')) message.audio = buffer
  else message.document = buffer
  return Dave.sendMessage(jid, { ...message, caption, ...options }, { quoted })
}

Dave.getFile = async (path, save = false) => {
  let buffer = Buffer.isBuffer(path) ? path
    : fs.existsSync(path) ? fs.readFileSync(path)
    : /^https?:\/\//.test(path) ? await getBuffer(path)
    : Buffer.alloc(0)
  let type = await FileType(buffer) || { mime: 'application/octet-stream', ext: '.bin' }
  let filename = path + '.' + type.ext
  if (save) fs.writeFileSync(filename, buffer)
  return { filename, size: buffer.length, ext: type.ext, mime: type.mime, data: buffer }
}

Dave.copyNForward = async (jid, message, forceForward = false, options = {}) => {
  let mtype = Object.keys(message.message)[0]
  let content = await generateForwardMessageContent(message, forceForward)
  const waMessage = await generateWAMessageFromContent(jid, content, options)
  await Dave.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id })
  return waMessage
}

Dave.cMod = (jid, copy, text = '', sender = Dave.user.id, options = {}) => {
  let mtype = Object.keys(copy.message)[0]
  let content = copy.message[mtype]
  if (typeof content === 'string') content = text || content
  else if (content.caption) content.caption = text || content.caption
  else if (content.text) content.text = text || content.text
  copy.message[mtype] = { ...content, ...options }
  copy.key.remoteJid = jid
  copy.key.fromMe = sender === Dave.user.id
  copy.key.id = copy.key.id || Dave.generateMessageID()
  return proto.WebMessageInfo.fromObject(copy)
}

Dave.getName = (jid, withoutContact = false) => {
  const id = Dave.decodeJid(jid)
  return Dave.contacts[id]?.name || Dave.contacts[id]?.notify || id.split('@')[0]
}

Dave.sendContact = async (jid, contacts = [], quoted = '', opts = {}) => {
  let contactsArray = await Promise.all(contacts.map(async (number) => {
    let vcard = `BEGIN:VCARD\nVERSION:3.0\nN:;;;\nFN:${number}\nTEL;type=CELL;type=VOICE;waid=${number}:${PhoneNumber('+' + number).getNumber('international')}\nEND:VCARD`
    return { displayName: number, vcard }
  }))
  await Dave.sendMessage(jid, { contacts: { displayName: `${contacts.length} Contact`, contacts: contactsArray }, ...opts }, { quoted })
}

Dave.setStatus = status => Dave.query({
  tag: 'iq',
  attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'status' },
  content: [{ tag: 'status', attrs: {}, content: Buffer.from(status, 'utf-8') }]
})

Dave.sendTextWithMentions = async (jid, text, quoted, options = {}) =>
  Dave.sendMessage(jid, {
    text,
    contextInfo: {
      mentionedJid: [...text.matchAll(/@(\d{5,16})/g)].map(m => m[1] + '@s.whatsapp.net'),
    },
    ...options
  }, { quoted })

Dave.sendText = (jid, text, quoted = '', options = {}) =>
  Dave.sendMessage(jid, { text, ...options }, { quoted })

Dave.sendButtonText = async (jid, buttons = [], text, footer, quoted = '', options = {}) => {
  const buttonMessage = {
    text,
    footer,
    buttons,
    headerType: 2,
    ...options
  }
  await Dave.sendMessage(jid, buttonMessage, { quoted })
}

Dave.send5ButImg = async (jid, text = '', footer = '', img, buttons = [], thumb, options = {}) => {
  const message = {
    image: img,
    caption: text,
    footer,
    buttons,
    headerType: 4,
    ...options
  }
  await Dave.sendMessage(jid, message, { quoted: options.quoted })
}
  Dave.ev.on('creds.update', saveCreds)

  const botNumber8 = Dave.user.id.split(':')[0]

  Dave.ev.on('groups.update', async updates => {
    for (const group of updates) {
      const metadata = await Dave.groupMetadata(group.id).catch(() => null)
      if (metadata) {
        botAdminStatus[group.id] = metadata.participants.some(p => p.id.includes(botNumber8) && p.admin)
      }
    }
  })

   Dave.ev.on('group-participants.update', async (update) => {
  const { id } = update

  // Save group metadata
   await saveGroupMetadata(id, Dave)

  // Welcome/leave handler
  await handleGroupParticipantsUpdate(Dave, update)

  // Update bot admin status in group
  try {
    const metadata = await Dave.groupMetadata(id)
    if (metadata) {
      botAdminStatus[id] = metadata.participants.some(p =>
        p.id.includes(botNumber8) && p.admin
      )
    }
  } catch (e) {
    console.warn(`⚠️ Failed to update admin status for ${id}:`, e.message)
  }
})

  Dave.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      return shouldReconnect ? connectToWA() : console.log('❌ Session invalid, please provide a new one.')
    }
    if (connection === 'open') {
      console.log('✅ XYLO-MD Connected!')
      await loadPlugins()
      await sendStartupMessage(Dave)
      const groups = Object.values(await Dave.groupFetchAllParticipating())
for (const group of groups) {
  await saveGroupMetadata(group.jid || group.id, Dave) // no await
}
    }
    if (qr) qrcode.generate(qr, { small: true })
  })
  
   // === Optimized messages.upsert ===
const groupCooldown = new Map()

Dave.ev.on('messages.upsert', async ({ messages }) => {
  let msg = messages[0]
  global.antideleteStore.set(msg.key.id, msg) // For antidelete

  const from = msg.key.remoteJid
  const isGroup = from.endsWith('@g.us')
  const sender = msg.key.fromMe
    ? (Dave.user.id.split(':')[0] + '@s.whatsapp.net')
    : (msg.key.participant || from)
  const botNumber = Dave.user.id.split(':')[0]
  const prefix = config.PREFIX

  const type = getContentType(msg.message)

  // 🔁 Strip viewOnce/ephemeral
  if (type === 'ephemeralMessage') msg.message = msg.message.ephemeralMessage.message
  if (type === 'viewOnceMessageV2') msg.message = msg.message.viewOnceMessageV2.message

    // 🧼 Anti-delete
if (type === 'protocolMessage' && msg.message?.protocolMessage?.type === 0) {
  await handleDeletedMessage(Dave, msg)
  return
}

    const newsletterJids = ['120363420616675201@newsletter']
    if (newsletterJids.includes(from)) {
      try {
        const serverId = msg.newsletterServerId
        if (serverId) {
          const emojis = ['🔥', '❤️', '💯', '💫', '🥰']
          const emoji = emojis[Math.floor(Math.random() * emojis.length)]
          await Dave.newsletterReactMessage(from, serverId.toString(), emoji)
          console.log(`📣 Reacted to newsletter ${from} with ${emoji}`)
        }
      } catch (e) {
        console.warn('⚠️ Failed to react to newsletter:', e.message)
      }
    }

    if (from === 'status@broadcast') {
  const autoView = await getConfig('autoview_status')
  const autoLike = await getConfig('autolike_status')
  const msgID = msg.key?.id
  const name = msg.pushName || msg.key.participant?.split('@')[0] || 'unknown'

  if (!msgID) return

  if (autoView) {
    try {
      await Dave.readMessages([msg.key])
    } catch (e) {
      console.error(`❌ Failed to auto-view ${name}'s status:`, e)
    }
  }

  if (autoLike) {
    try {
      const emojis = ['❤️', '🌹', '😇', '🤡', '🍆', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '👄', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🍑', '🌷', '⛅', '🌟', '✨', '🇳🇬', '💜', '💙', '🌝', '💚']
      const reaction = emojis[Math.floor(Math.random() * emojis.length)]
      const botJid = await Dave.decodeJid(Dave.user.id)
      const jidList = [msg.key?.participant, botJid].filter(Boolean)

      await Dave.sendMessage(from, {
        react: {
          text: reaction,
          key: msg.key
        }
      }, {
        statusJidList: jidList
      })
    } catch (e) {
      console.error(`❌ Failed to react to ${name}'s status:`, e)
    }
  }

  return
}
    
  // 💬 Setup quoted message
  const msgContent = msg.message?.extendedTextMessage || msg.message?.imageMessage || msg.message?.videoMessage || {}
  if (msgContent?.contextInfo?.quotedMessage) {
    const quotedMsg = msgContent.contextInfo.quotedMessage
    const quotedType = Object.keys(quotedMsg)[0]
    const quotedSender = msgContent.contextInfo.participant || msg.key.remoteJid
    msg.quoted = {
      key: {
        remoteJid: msg.key.remoteJid,
        fromMe: quotedSender === Dave.user.id,
        id: msgContent.contextInfo.stanzaId,
        participant: quotedSender
      },
      message: quotedMsg,
      mtype: quotedType,
      download: () => Dave.downloadMediaMessage({ message: quotedMsg }, 'buffer')
    }
  }

  // 🛑 Skip non-commands (but keep moderation active)
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
  const isCmd = body.startsWith(prefix)
  if (!isCmd) return

  // 🧯 Cooldown per group (3 sec)
  if (isGroup && groupCooldown.has(from)) return
  groupCooldown.set(from, Date.now())
  setTimeout(() => groupCooldown.delete(from), 3000)

  // ⚙️ Parse command
  const args = body.slice(prefix.length).trim().split(/\s+/)
  const commandName = args.shift()?.toLowerCase()
  const plugin = globalPlugins.get(commandName)
  if (!plugin) return

  const userNumber = (sender || '').split('@')[0]
  const isCreator = CREATOR_NUMBERS.includes(userNumber)
  const isMe = botNumber.includes(userNumber)
  const isSudo = global.sudoUsers.includes(sender)
  const isOwner = ownerNumber.includes(userNumber) || isMe || isSudo
  const isBanned = global.bannedUsers.includes(sender)

  if (isBanned) {
    await Dave.sendMessage(from, { text: '🚫 You are banned from using this bot.' }, { quoted: msg })
    return
  }

  if (config.MODE === 'private' && !(isOwner || isCreator)) return

  const Group = from.endsWith('@g.us')
    const [groupMetadata, admin, botAdmin] = Group
  ? await Promise.all([
      Dave.groupMetadata(from).catch(() => ({})),
      getGroupAdmin(from, sender),
      getBotAdmin(from, Dave.user.id.split(':')[0])
    ])
  : [{}, false, false]
  
  const reply = (txt, opt = {}) => Dave.sendMessage(from, { text: txt, ...opt }, { quoted: msg })

  const m = {
    ...msg,
    jid: sender,
    sender,
    from,
    isGroup,
    quoted: msg.quoted,
    reply,
    args,
    body,
    text: args.join(' '),
    commandName,
    type,
    senderName: msg.pushName || 'Unknown',
    groupMetadata
  }

  try {
    await plugin.handler({
      msg,
      args,
      body,
      from,
      sender,
      content: JSON.stringify(msg.message),
      pushname: msg.pushName || 'Sin Nombre',
      type,
      Dave,
      prefix,
      text: args.join(' '),
      botNumber,
      isGroup,
      isOwner,
      isCreator,
      globalPlugins,
      isSudo,
      isBanned,
      client: Dave,
      message: msg,
      m,
      reply,
      quoted: msg.quoted,
      groupMetadata,
      isAdmin: admin,
      botAdmin
    })
  } catch (err) {
    console.error(`❌ Error in ${commandName}:`, err.message)
  }
})
  // ✅ Call antilink setup with admin checker function
  setupModerationDetection(Dave, (jid) => botAdminStatus[jid] ?? false)
  
await setupChatbotListener(Dave)

setupGameListener(Dave)

  Dave.ev.on('messages.update', async updates => {
    for (const msg of updates) {
      if (msg.update?.message === null) {
        await handleDeletedMessage(Dave, msg)
      }
    }
  })
}

async function loadPlugins() {
  const pluginDir = path.join(__dirname, 'plugins')
  if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir)

  globalPlugins.clear()

  const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'))

  for (const file of files) {
    const fullPath = pathToFileURL(path.join(pluginDir, file)).href
    try {
      // Clear previous cache for hot reload
      const resolved = await import(fullPath + `?update=${Date.now()}`)
      const plugins = resolved.default

      if (!Array.isArray(plugins)) {
        console.warn(`⚠️ Skipped non-array export in ${file}`)
        continue
      }

      for (const plugin of plugins) {
        if (typeof plugin.handler !== 'function') {
          console.warn(`⚠️ Skipped plugin with no valid handler in ${file}`)
          continue
        }

        if (plugin.name) {
          const allNames = [plugin.name, ...(plugin.alias || [])].map(n => n.toLowerCase())
          for (const name of allNames) {
            if (globalPlugins.has(name)) {
              console.warn(`⚠️ Duplicate command or alias '${name}' in ${file}`)
              continue
            }
            globalPlugins.set(name, plugin)
          }
        } else if (plugin.on) {
          const trigger = plugin.on.toLowerCase()
          if (globalPlugins.has(trigger)) {
            console.warn(`⚠️ Duplicate trigger '${trigger}' in ${file}`)
            continue
          }
          globalPlugins.set(trigger, plugin)
          console.log(`📌 Trigger plugin loaded: ${trigger} (${file})`)
        } else {
          console.warn(`⚠️ Skipped plugin in ${file} with no name or trigger`)
        }
      }

      console.log(`✅ Plugin loaded: ${file}`)
    } catch (err) {
      console.error(`❌ Plugin error (${file}):`, err.message || err)
    }
  }
}
async function sendStartupMessage(Dave) {
  try {
    await Dave.sendMessage(Dave.user.id, {
      image: { url: 'https://i.postimg.cc/QNprd7CF/IMG-20250722-WA1105.jpg' },
      caption: `*Welcome to XYLO-MD*\n\n> Mode: ${config.MODE}\n> Prefix: ${config.PREFIX}`
    })
  } catch {
    console.warn('⚠️ Could not send startup message.')
  }
}

connectToWA()


const app = express()
app.get('/', (_, res) => res.send('XYLO-MD is running!'))
app.listen(process.env.PORT || 3000, () => console.log('🌐 Server up n active'))
