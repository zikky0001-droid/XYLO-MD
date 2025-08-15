import fetch from 'node-fetch'
import path from 'path'
import fs from 'fs'
import mime from 'mime-types'

export default [
  {
    name: 'fetch',
    category: 'tools',
    description: 'Fetches a URL and sends it based on content type',
    handler: async ({ msg, Dave, args, quoted, from }) => {
      // Get URL from arguments or quoted text
      let url = args
      if (!url && quoted && quoted.text) {
        const match = quoted.text.match(/https?:\/\/[^\s]+/i)
        if (match) url = match[0]
      }

      if (!url) {
        return Dave.sendMessage(from, { text: '❌ Please provide or quote a URL to fetch.' }, { quoted: msg })
      }

      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`)

        const contentType = res.headers.get('content-type') || ''
        const buffer = await res.arrayBuffer()
        const data = Buffer.from(buffer)

        // Decide what to send based on content type
        if (contentType.startsWith('image/')) {
          await Dave.sendMessage(from, { image: data, caption: `📷 From ${url}` }, { quoted: msg })
        } 
        else if (contentType.startsWith('video/')) {
          await Dave.sendMessage(from, { video: data, caption: `🎥 From ${url}` }, { quoted: msg })
        } 
        else if (contentType.startsWith('audio/')) {
          await Dave.sendMessage(from, { audio: data, mimetype: contentType }, { quoted: msg })
        } 
        else if (contentType.includes('text') || contentType.includes('json')) {
          const text = data.toString('utf8')
          if (text.length < 1500) {
            await Dave.sendMessage(from, { text: `📝 From ${url}\n\n${text}` }, { quoted: msg })
          } else {
            const filePath = path.join('./temp', `fetched_${Date.now()}.txt`)
            fs.writeFileSync(filePath, text)
            await Dave.sendMessage(msg.key.remoteJid, { document: fs.readFileSync(filePath), mimetype: 'text/plain', fileName: 'fetched.txt' }, { quoted: msg })
            fs.unlinkSync(filePath)
          }
        } 
        else {
          // Unknown / other file types → send as document
          const ext = mime.extension(contentType) || 'bin'
          const filePath = path.join('./temp', `fetched_${Date.now()}.${ext}`)
          fs.writeFileSync(filePath, data)
          await Dave.sendMessage(from, { document: fs.readFileSync(filePath), mimetype: contentType, fileName: `fetched.${ext}` }, { quoted: msg })
          fs.unlinkSync(filePath)
        }

      } catch (err) {
        console.error(err)
        await Dave.sendMessage(from, { text: `❌ Failed to fetch URL.\n${err.message}` }, { quoted: msg })
      }
    }
  }
]
